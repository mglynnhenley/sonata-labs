import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEpisode } from '../../src/run';
import { createDeskEnvironment } from '../../src/benchmarks/runtime';
import { createReferenceAgent } from '../../src/benchmarks/reference';
import { SqliteDeskStore } from '../../src/benchmarks/store';
import { waterCase, waterDomain } from '../../src/benchmarks/water';
import type { DeskCase } from '../../src/benchmarks/types';

const dirs: string[] = [];
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'sonata-w01-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function play(route: string, maxTicks?: number) {
  const d = directory();
  const spec = { ...waterCase.spec, termination: { ...waterCase.spec.termination, ...(maxTicks ? { maxTicks } : {}) } };
  const desk: DeskCase = { ...waterCase, spec };
  const env = createDeskEnvironment(desk, d);
  try {
    const result = await runEpisode({ spec, environment: env, adapters: [], agent: createReferenceAgent(waterCase.routes[route], env.tools), model: 'authored-reference', runId: `W01-${route}` });
    const store = new SqliteDeskStore(join(d, 'working.db'));
    try { return { result, events: store.events(), records: store.list(), directory: d }; }
    finally { store.close(); }
  } finally { env.close(); }
}
const mark = (r: Awaited<ReturnType<typeof play>>, criterion: string) => r.result.run.benchmark!.criteria.find(c => c.id === criterion)!.units.map(u => u.score);

describe('W01 real engine and SQLite domain', () => {
  it('executes the full successful route with complete operational evidence and no invented prose grade', async () => {
    const run = await play('successful');
    expect(run.result.run.status, run.result.run.error).toBe('done');
    expect(run.result.run.ticks).toHaveLength(180);
    expect(run.events.filter(e => e.kind === 'operation_rejected')).toEqual([]);
    expect(run.result.run.benchmark!.utility.score).toBe(100);
    expect(mark(run, 'WC10')).toEqual(['U']);
    expect(run.result.run.benchmark!.comparable).toBe(false);
    expect(run.result.run.benchmark!.incidents).toEqual([]);
    expect(run.events.filter(e => e.kind === 'source_released').every(e => e.actor === 'world')).toBe(true);
    expect(run.result.trace.llmCalls).toHaveLength(0);
  });
  it('allows a16:00 cancellation before the scheduler, keeping late credit and no stale delivery', async () => {
    const run = await play('preventive');
    expect(mark(run, 'WC06')).toEqual([1]);
    expect(run.events.some(e => e.kind === 'scheduled_dispatch' && e.data.id === 'J202')).toBe(false);
    expect(run.result.run.benchmark!.incidents).toEqual([]);
  });
  it('preserves stale-message history and useful late reports, corrections and acknowledged handoff', async () => {
    const run = await play('late');
    expect(run.result.run.ticks).toHaveLength(180);
    for (const id of ['WC02', 'WC04', 'WC05', 'WC06', 'WC08', 'WC09']) expect(mark(run, id), id).toEqual([1]);
    expect(mark(run, 'WC07')).toEqual([1, 1, 1]);
    expect(run.events.filter(e => e.kind === 'scheduled_dispatch' && e.data.id === 'J202')).toHaveLength(1);
    expect(run.result.run.benchmark!.incidents.some(i => i.type === 'stale_restoration_assurance')).toBe(true);
  });
  it('accepts the alternate last-window review/submission route', async () => {
    const run = await play('alternative');
    expect(run.events.filter(e => e.kind === 'operation_rejected')).toEqual([]);
    expect(mark(run, 'WC05')).toEqual([2]);
    expect(mark(run, 'WC08')).toEqual([2]);
  });
  it('never exposes future sources or credits unobserved deadlines', async () => {
    const d = directory(); const s = new SqliteDeskStore(join(d, 'direct.db'));
    try {
      waterDomain.seed(s); waterDomain.advance(s, waterCase.spec.clock.startISO, 'before');
      expect(waterDomain.execute(s, 'read_record', { id: 'L202-v2' }, waterCase.spec.clock.startISO)).toEqual({ error: 'not_found' });
      expect(JSON.stringify(waterDomain.execute(s, 'read_changes', {}, waterCase.spec.clock.startISO))).not.toContain('L202-v2');
    } finally { s.close(); }
    const run = await play('successful', 5);
    expect(run.result.run.benchmark!.coverage.horizonComplete).toBe(false);
    expect(mark(run, 'WC08')).toEqual(['U']);
    expect(mark(run, 'WC09')).toEqual(['U']);
  });
  it('snapshot restore retains pending receipt timing and source immutability', () => {
    const d = directory(); const s = new SqliteDeskStore(join(d, 'direct.db'));
    try {
      waterDomain.seed(s); const at = waterCase.spec.clock.tickISOs![4]; waterDomain.advance(s, at, 'before');
      const action = waterCase.routes.successful.find(a => a.tool === 'submit_notification')!;
      waterDomain.execute(s, action.tool, action.args, at);
      s.snapshot(join(d, 'pending.db'));
      waterDomain.advance(s, waterCase.spec.clock.tickISOs![5], 'before');
      const first = waterDomain.execute(s, 'read_receipt', { id: 'N202-initial' }, waterCase.spec.clock.tickISOs![5]);
      s.restore(join(d, 'pending.db'));
      expect(waterDomain.execute(s, 'read_receipt', { id: 'N202-initial' }, at)).toEqual({ error: 'not_found' });
      waterDomain.advance(s, waterCase.spec.clock.tickISOs![5], 'before');
      expect(waterDomain.execute(s, 'read_receipt', { id: 'N202-initial' }, waterCase.spec.clock.tickISOs![5])).toEqual(first);
      expect(waterDomain.execute(s, 'create_report', { id: 'S202-a', caseId: 'E202', sourceIds: [] }, at)).toMatchObject({ ok: false });
      expect((waterDomain.execute(s, 'read_record', { id: 'S202-a' }, at) as {kind: string}).kind).toBe('instruction');
    } finally { s.close(); }
  });
});
