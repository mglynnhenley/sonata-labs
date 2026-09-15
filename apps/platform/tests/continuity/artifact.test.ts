import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateBenchmark } from '@sonata/judge';
import { waterReporting } from '@sonata/scenarios';
import { readRun } from '../../app/results/_lib/artifacts';
import { specForRun } from '../../src/lib/engine/scenarios';
let dir: string;
const previous = process.env.SONATA_RUNS_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'continuity-artifact-')); process.env.SONATA_RUNS_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.SONATA_RUNS_DIR; else process.env.SONATA_RUNS_DIR = previous; });
function artifact() {
  const snapshots = { before: join(dir, 'before.db'), after: join(dir, 'after.db') };
  writeFileSync(snapshots.before, 'snapshot placeholder for artifact shape test'); writeFileSync(snapshots.after, 'snapshot placeholder for artifact shape test');
  const benchmark = aggregateBenchmark({ caseId: 'W01', completion: 'complete', completedTicks: 180, plannedTicks: 180, completedThrough: waterReporting.clock.endISO!, snapshots,
    criteria: Array.from({ length: 6 }, (_, i) => ({ id: `C${i}`, family: `F${i}`, reporting: i === 5, units: [{ id: 'u', score: 2 as const, evidence: ['receipt'], reason: 'checked' }] })), incidents: [], limitations: [] });
  return { runId: 'test', specId: waterReporting.id, specTitle: waterReporting.title, spec: waterReporting, model: 'reference-policy', status: 'done', startedAt: 1, endedAt: 2, snapshots: {}, benchmark,
    ticks: waterReporting.clock.tickISOs!.map((simTimeISO, tick) => ({ tick, simTimeISO, startedAt: tick, endedAt: tick + 1, beatsFired: [], directorEvents: [], agentSteps: [], notes: [] })), verdict: null };
}
it('preserves and recomputes the separate domain report on read', () => {
  const data = artifact(); data.benchmark.utility.score = -123;
  writeFileSync(join(dir, 'test.json'), JSON.stringify(data));
  const saved = readRun('test')!;
  expect(saved.benchmark?.utility.score).toBe(100);
  expect(saved.verdict).toBeNull();
});
it('refuses full credit when the saved report exceeds observed ticks', () => {
  const data = artifact(); data.ticks = data.ticks.slice(0, 4);
  writeFileSync(join(dir, 'test.json'), JSON.stringify(data));
  expect(readRun('test')?.benchmark?.utility.score).toBeNull();
  expect(readRun('test')?.benchmark?.completedTicks).toBe(4);
});
it('does not revive a forged empty legacy score when the domain report is malformed', () => {
  const data = { ...artifact(), benchmark: {}, verdict: { outcome: 'pass', score: 100, autonomy: 100, checklist: [] } };
  writeFileSync(join(dir, 'test.json'), JSON.stringify(data));
  expect(readRun('test')?.verdict).toBeNull();
});
it('withholds complete utility when the persisted snapshot is missing', () => {
  const data = artifact(); rmSync(data.benchmark.snapshots.after);
  writeFileSync(join(dir, 'test.json'), JSON.stringify(data));
  expect(readRun('test')?.benchmark?.utility.score).toBeNull();
});
it('caps a smoke run without rewriting the original week', () => {
  const capped = specForRun(waterReporting, 4);
  expect(capped.clock.ticks).toBe(180);
  expect(capped.clock.tickISOs).toHaveLength(180);
  expect(capped.termination.maxTicks).toBe(4);
});
