import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electricityCase, electricityDomain } from '@sonata/desks';
import { SqliteDeskStore } from '@sonata/desks';
import { createDeskEnvironment } from '../src/benchmarks/runtime';
import { createReferenceAgent } from '../src/benchmarks/reference';
import { runEpisode } from '../src/run';
const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'e01-test-')); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('E01 routes through runEpisode and SQLite', () => {
  for (const [name, actions] of Object.entries(electricityCase.routes)) it(name, async () => {
    const env = createDeskEnvironment(electricityCase, directory());
    try {
      const result = await runEpisode({ spec: electricityCase.spec, adapters: [], model: 'reference/no-model', agent: createReferenceAgent(actions, env.tools), environment: env });
      expect(result.run.status).toBe('done');
      const failed = result.run.ticks.flatMap(t => t.agentSteps).filter(s => s.kind === 'tool' && (s.error || s.resultSummary.includes('"ok":false')));
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(result.run.ticks).toHaveLength(180);
      const report = result.run.benchmark!;
      const store = new SqliteDeskStore(report.snapshots.after);
      try {
        const assessment = electricityDomain.assess(store, '2026-09-25T17:00:00.000Z');
        const units = assessment.criteria.filter(c => !c.reporting).flatMap(c => c.units.map(u => ({ criterion: c.id, ...u })));
        const partial = name === 'late_safe_amendment' ? ['EO07'] : name === 'next_day_recovery' ? ['EO02', 'EO03'] : [];
        for (const unit of units) expect(unit.score, `${name}: ${unit.criterion}/${unit.id}: ${unit.reason}`).toBe(partial.includes(unit.criterion) ? 1 : 2);
        expect(store.events().filter(e => ['arrival', 'commissioning', 'site-acceptance', 'return-proof', 'receipt'].includes(e.kind)).every(e => e.actor === 'world')).toBe(true);
        expect(store.get('inventory')).toEqual(name === 'mirror_allocation' ? { G11: 'free', G12: 'booking-C-22' } : { G11: name === 'next_day_recovery' ? 'booking-C-23' : 'booking-C-22', G12: 'free' });
      } finally { store.close(); }
    } finally { env.close(); }
  });
});
describe('E01 guards', () => {
  function desk() { const s = new SqliteDeskStore(join(directory(), 'working.db')); electricityDomain.seed(s); return s; }
  it('hides future sources and cannot mint physical fulfilment from local flags', () => {
    const s = desk();
    try {
      expect(electricityDomain.execute(s, 'read_record', { id: 'E1' }, '2026-09-21T08:00:00.000Z')).toEqual({ ok: false, error: 'record-unavailable' });
      const ids = electricityDomain.execute(s, 'list_due', {}, '2026-09-21T08:00:00.000Z') as Array<{ id: string }>;
      expect(ids.some(r => r.id === 'E1' || r.id === 'F-C')).toBe(false);
      electricityDomain.execute(s, 'update_case', { id: 'C', state: 'fulfilled', evidence: ['C'] }, '2026-09-21T08:00:00.000Z');
      expect(electricityDomain.assess(s, '2026-09-25T17:00:00.000Z').criteria.find(c => c.id === 'EO03')!.units.map(u => u.score)).toEqual([0, 0]);
      expect(s.get('inventory')).toEqual({ G11: 'free', G12: 'free' });
    } finally { s.close(); }
  });
  it('records a 17:45 request receipt at actual 18:00 before next opening', () => {
    const s = desk();
    try {
      electricityDomain.execute(s, 'request_check', { kind: 'site', packet: { site: 'C', contact: 'elaine', map: 'M1', access: 'A-C1' } }, '2026-09-21T16:45:00.000Z');
      electricityDomain.advance(s, '2026-09-22T08:00:00.000Z', 'before');
      expect(s.get<{ at: string }>('record:confirm-C')?.at).toBe('2026-09-21T17:00:00.000Z');
    } finally { s.close(); }
  });
  it('cannot accept weekend coverage without an actual deployment', () => {
    const s = desk();
    try {
      expect(electricityDomain.execute(s, 'request_check', { kind: 'weekend_roster', packet: { booking: 'booking-C-22' } }, '2026-09-25T14:00:00.000Z')).toMatchObject({ ok: false, error: 'no_active_deployment' });
      expect(s.get('job:C-roster')).toBeUndefined();
    } finally { s.close(); }
  });
});

it('prevents forged reconciliation from erasing open duty obligations', () => {
  const s = new SqliteDeskStore(join(directory(), 'working.db'));
  try {
    electricityDomain.seed(s);
    const at = '2026-09-23T15:45:00.000Z';
    electricityDomain.execute(s, 'update_case', { id: 'H73', state: 'fulfilled', evidence: ['H73'] }, at);
    electricityDomain.execute(s, 'update_case', { id: 'W', state: 'returned', evidence: ['S-W'] }, at);
    for (let n = 41; n <= 46; n++) electricityDomain.execute(s, 'update_case', { id: `R${n}`, state: 'delivered', evidence: [`R${n}`] }, at);
    const result = electricityDomain.execute(s, 'assign_handoff', { owner: 'leah', items: [] }, at);
    expect(result).toMatchObject({ ok: false, error: 'duty-packet-incomplete', missing: expect.arrayContaining(['W:item', 'H73:item', 'R45:item']) });
  } finally { s.close(); }
});

it('makes no-action omissions measured zero after the complete horizon', async () => {
  const env = createDeskEnvironment(electricityCase, directory());
  try {
    const result = await runEpisode({ spec: electricityCase.spec, adapters: [], model: 'reference/no-model', agent: createReferenceAgent([], env.tools), environment: env });
    const s = new SqliteDeskStore(result.run.benchmark!.snapshots.after);
    try {
      const scored = electricityDomain.assess(s, '2026-09-25T17:00:00.000Z');
      expect(scored.criteria.flatMap(c => c.units).every(u => u.score === 0)).toBe(true);
    } finally { s.close(); }
  } finally { env.close(); }
});

it('blocks shared-crew double booking and keeps a dispatched unit occupied', async () => {
  const env = createDeskEnvironment(electricityCase, directory());
  const actions = electricityCase.routes.reference.filter(a => a.tick <= 54);
  const duplicate = actions.find(a => a.tool === 'request_booking' && (a.args.packet as Record<string, unknown>)?.site === 'W')!;
  actions.push({ tick: 40, tool: 'request_booking', args: { kind: 'deployment', packet: { ...(duplicate.args.packet as Record<string, unknown>), crew: 'V1', authority: 'K1' } } });
  actions.push({ tick: 53, tool: 'cancel_booking', args: { booking: 'booking-C-22', version: 1, reason: 'try to reuse occupied equipment' } });
  try {
    const result = await runEpisode({ spec: electricityCase.spec, adapters: [], model: 'reference/no-model', agent: createReferenceAgent(actions, env.tools), environment: env });
    const s = new SqliteDeskStore(result.run.benchmark!.snapshots.after);
    try {
      const blocked = s.events().filter(e => e.kind === 'blocked').map(e => e.data.code);
      expect(blocked).toContain('crew-slot-occupied');
      expect(blocked).toContain('qualified_release_required');
      expect(s.get('inventory')).toEqual({ G11: 'booking-C-22', G12: 'booking-W-22' });
    } finally { s.close(); }
  } finally { env.close(); }
});

it('an omitted access amendment causes a real blocked service, without inventing proof', async () => {
  const env = createDeskEnvironment(electricityCase, directory());
  const actions = electricityCase.routes.reference.filter(a => a.tick < 148 && a.tool !== 'amend_booking');
  try {
    const result = await runEpisode({ spec: electricityCase.spec, adapters: [], model: 'reference/no-model', agent: createReferenceAgent(actions, env.tools), environment: env });
    const s = new SqliteDeskStore(result.run.benchmark!.snapshots.after);
    try {
      expect(s.events().some(e => e.kind === 'service-blocked' && e.actor === 'world')).toBe(true);
      expect(s.get('record:booking-C-22-service-24')).toBeUndefined();
      expect(electricityDomain.assess(s, '2026-09-25T17:00:00.000Z').criteria.find(c => c.id === 'EO07')!.units[0].score).toBe(0);
    } finally { s.close(); }
  } finally { env.close(); }
});

it('approval windows preserve the exact 09:45 cutoff and do not backdate a late packet', () => {
  const packet = electricityCase.routes.reference.find(a => a.tool === 'request_exception')!.args;
  for (const [requestAt, expected] of [['2026-09-22T08:45:00.000Z', '2026-09-22T09:15:00.000Z'], ['2026-09-22T09:00:00.000Z', '2026-09-22T14:15:00.000Z']]) {
    const s = new SqliteDeskStore(join(directory(), 'working.db'));
    try {
      electricityDomain.seed(s);
      expect(electricityDomain.execute(s, 'request_exception', packet, requestAt)).toMatchObject({ ok: true, availableAt: expected });
    } finally { s.close(); }
  }
});

it('a current E2 update partially repairs a missed E1 update without restoring timely credit', async () => {
  const env = createDeskEnvironment(electricityCase, directory());
  const actions = electricityCase.routes.reference.filter(a => !(a.tool === 'send_update' && a.args.source === 'E1'));
  try {
    const result = await runEpisode({ spec: electricityCase.spec, adapters: [], model: 'reference/no-model', agent: createReferenceAgent(actions, env.tools), environment: env });
    const s = new SqliteDeskStore(result.run.benchmark!.snapshots.after);
    try {
      const scored = electricityDomain.assess(s, '2026-09-25T17:00:00.000Z').criteria.find(c => c.id === 'EO04')!;
      expect(scored.units.map(u => u.score)).toEqual([1, 1, 1, 2, 2, 2]);
    } finally { s.close(); }
  } finally { env.close(); }
});

it('a site update cannot disclose a household source', () => {
  const s = new SqliteDeskStore(join(directory(), 'working.db'));
  try {
    electricityDomain.seed(s);
    expect(electricityDomain.execute(s, 'send_update', { recipient: 'elaine', source: 'H73', state: 'assistance-pending', message: 'Household details' }, '2026-09-22T14:00:00.000Z')).toMatchObject({ ok: false, error: 'source-not-authorised-for-site-update' });
  } finally { s.close(); }
});
