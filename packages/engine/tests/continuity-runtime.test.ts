import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEpisode } from '../src/run';
import { createAgent } from '../src/agent';
import { fn } from '../src/tools/types';
import { createDeskEnvironment } from '../src/benchmarks/runtime';
import { createReferenceAgent } from '../src/benchmarks/reference';
import { SqliteDeskStore } from '../src/benchmarks/store';
import type { DeskCase } from '../src/benchmarks/types';
import { spec } from './fixtures';
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'continuity-')); directories.push(path); return path; };
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function desk(): DeskCase {
  return {
    spec: spec({ benchmark: { kind: 'continuity', caseId: 'W01', version: 1 }, termination: { idleTicks: 0, stopWhenAllMustPass: false, maxWallClockMs: 10000 } }),
    domain: {
      id: 'W01', tools: [{ name: 'cancel', description: 'Cancel scheduled dispatch', parameters: { type: 'object', properties: {} }, mutation: true }],
      seed(s) { s.put('job', { cancelled: false }); },
      advance(s, at, phase) {
        if (at.endsWith('09:15:00.000Z') && phase === 'before') s.event(at, 'world', 'receipt', {});
        if (at.endsWith('09:15:00.000Z') && phase === 'after' && !s.get<{cancelled:boolean}>('job')?.cancelled) s.event(at, 'world', 'dispatch', {});
      },
      execute(s, _tool, _args, at) { s.put('job', { cancelled: true }); s.event(at, 'agent', 'cancel', {}); return { cancelled: true }; },
      assess(s) { return { criteria: Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, family: `F${i}`, units: [{ id: 'u', score: s.events().some(e => e.kind === 'dispatch') ? 0 : 2, evidence: [], reason: 'Actual dispatch history' }] })), incidents: [], limitations: [] }; },
    }, routes: { success: [{ tick: 1, tool: 'cancel', args: {} }] },
  };
}
describe('persisted continuity runtime', () => {
  it('releases receipts before calls and permits cancellation before the scheduled job', async () => {
    const c = desk(); const env = createDeskEnvironment(c, directory());
    const result = await runEpisode({ spec: c.spec, environment: env, adapters: [], model: 'reference-policy', agent: createReferenceAgent(c.routes.success, env.tools), director: { react: async () => [], lastNote: () => undefined } });
    env.close();
    expect(result.run.status).toBe('done');
    const report = result.run.benchmark!;
    expect(report.coverage.horizonComplete).toBe(true);
    const saved = new SqliteDeskStore(report.snapshots.after);
    expect(saved.events().map(e => [e.kind, e.actor])).toEqual([['receipt', 'world'], ['cancel', 'agent']]);
    saved.restore(report.snapshots.before);
    expect(saved.events()).toEqual([]);
    expect(saved.get('job')).toEqual({ cancelled: false });
    saved.close();
  });
  it('preserves the full denominator when a smoke run stops early', async () => {
    const c = desk(); c.spec.termination.maxTicks = 1;
    const env = createDeskEnvironment(c, directory());
    const result = await runEpisode({ spec: c.spec, environment: env, adapters: [], model: 'reference-policy', agent: createReferenceAgent([], env.tools), director: { react: async () => [], lastNote: () => undefined } });
    env.close();
    expect(result.run.benchmark?.completedTicks).toBe(1);
    expect(result.run.benchmark?.plannedTicks).toBe(4);
    expect(result.run.benchmark?.utility.score).toBeNull();
  });
  it('fails a declared case without its domain instead of running an empty success', async () => {
    const result = await runEpisode({ spec: desk().spec, adapters: [], model: 'reference-policy', agent: createReferenceAgent([], []), director: { react: async () => [], lastNote: () => undefined } });
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('requires its deterministic desk environment');
  });
  it('withholds a complete score when the model provider fails', async () => {
    const c = desk(); const env = createDeskEnvironment(c, directory());
    const agent = createAgent({ spec: c.spec, tools: env.tools, chat: async () => { throw new Error('provider unavailable'); } });
    const result = await runEpisode({ spec: c.spec, environment: env, adapters: [], model: 'test-provider', agent, director: { react: async () => [], lastNote: () => undefined } });
    env.close();
    expect(result.run.status).toBe('failed');
    expect(result.run.benchmark?.completion).toBe('failed');
    expect(result.run.benchmark?.utility.score).toBeNull();
  });
  it('records unexpected storage/domain exceptions as measurement failure', async () => {
    const c = desk(); c.domain.execute = () => { throw new Error('missing receipt table'); };
    const env = createDeskEnvironment(c, directory());
    const result = await runEpisode({ spec: c.spec, environment: env, adapters: [], model: 'reference-policy', agent: createReferenceAgent(c.routes.success, env.tools), director: { react: async () => [], lastNote: () => undefined } });
    env.close();
    expect(result.run.benchmark?.completion).toBe('failed');
    expect(result.run.benchmark?.utility.score).toBeNull();
    expect(result.run.benchmark?.limitations.join(' ')).toContain('missing receipt table');
  });
  it('caps actual tool execution even when one model turn requests seven calls', async () => {
    let executed = 0;
    const agent = createAgent({ spec: desk().spec, tools: [{ name: 'read', twin: null, isMutation: false, def: fn('read', 'Read a record', { type: 'object', properties: {} }), run: async () => ++executed }], chat: async () => ({ role: 'assistant', content: null, refusal: null, tool_calls: Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, type: 'function' as const, function: { name: 'read', arguments: '{}' } })) }) });
    const steps = await agent.act({ tick: 0, simTimeISO: '2026-08-04T09:00:00Z', simTimeLabel: '09:00', digest: '', ticksLeft: 3 });
    expect(executed).toBe(6);
    expect(steps.filter(s => s.kind === 'tool')).toHaveLength(6);
  });
});
