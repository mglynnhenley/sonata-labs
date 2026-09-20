import Ajv from 'ajv';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateClock, type BenchmarkReport, type EpisodeSpec } from '@sonata/core';
import { aggregateBenchmark } from '@sonata/judge/benchmark';
import type { AgentContext } from '../agent';
import { fn, type EngineTool } from '../tools/types';
import { SqliteDeskStore, type DeskCase } from '@sonata/desks';

export interface EpisodeEnvironment {
  caseId: string;
  tools: EngineTool[];
  beforeTick(ctx: AgentContext): void;
  afterTick(ctx: AgentContext): void;
  finish(completedTicks: number, failed: boolean): BenchmarkReport;
  close(): void;
}

export function createDeskEnvironment(desk: DeskCase, directory: string): EpisodeEnvironment {
  validateClock(desk.spec.clock);
  mkdirSync(directory, { recursive: true });
  const working = join(directory, 'working.db');
  if (existsSync(working)) throw new Error(`Run ledger already exists: ${working}. Use a new run directory.`);
  const store = new SqliteDeskStore(working);
  const before = join(directory, 'before.db');
  const after = join(directory, 'after.db');
  store.transaction(() => desk.domain.seed(store));
  store.snapshot(before);
  let current: AgentContext | undefined;
  let calls = 0;
  let closed = false;
  const faults: string[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validators = new Map(desk.domain.tools.map(tool => [tool.name, ajv.compile(tool.parameters)]));
  const tools: EngineTool[] = desk.domain.tools.map(tool => ({
    name: tool.name, twin: null, isMutation: tool.mutation,
    def: fn(tool.name, tool.description, tool.parameters),
    async run(args) {
      if (!current) throw new Error('The desk is outside an active opportunity.');
      if (calls >= 6) throw new Error('Six calls used in this opportunity; continue at the next interval.');
      calls++;
      const validate = validators.get(tool.name)!;
      if (!validate(args)) return { ok: false, error: "Invalid tool arguments", fields: validate.errors };
      try { return store.transaction(() => desk.domain.execute(store, tool.name, args, current!.simTimeISO)); }
      catch (error) {
        faults.push(`Operational tool ${tool.name} threw: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
  }));
  return {
    caseId: desk.domain.id,
    tools,
    beforeTick(ctx) {
      current = ctx; calls = 0;
      store.transaction(() => desk.domain.advance(store, ctx.simTimeISO, 'before'));
    },
    afterTick(ctx) {
      store.transaction(() => desk.domain.advance(store, ctx.simTimeISO, 'after'));
      current = undefined;
    },
    finish(completedTicks, failed) {
      failed = failed || faults.length > 0;
      const clock = desk.spec.clock;
      const full = !failed && completedTicks === clock.ticks;
      const last = completedTicks ? clock.tickISOs?.[completedTicks - 1] ?? new Date(Date.parse(clock.startISO) + (completedTicks - 1) * clock.simMinutesPerTick * 60_000).toISOString() : null;
      const through = full ? clock.endISO ?? new Date(Date.parse(last!) + clock.simMinutesPerTick * 60_000).toISOString() : last;
      // Only a complete observed week flushes closing receipts. Truncated runs do
      // not advance through an unobserved afternoon to manufacture outcomes.
      if (full && through) store.transaction(() => {
        desk.domain.advance(store, through, 'before');
        desk.domain.advance(store, through, 'after');
      });
      const assessment = desk.domain.assess(store, through);
      assessment.limitations.push(...faults);
      if (failed) assessment.limitations.push('The run failed before normal completion; inspect its error and observed horizon.');
      store.snapshot(after);
      return aggregateBenchmark({
        caseId: desk.domain.id, ...assessment, completedTicks, completion: failed ? "failed" : full ? "complete" : "partial",
        plannedTicks: clock.ticks, snapshots: { before, after }, completedThrough: through,
      });
    },
    close() { if (!closed) { store.close(); closed = true; } },
  };
}

export function requireEnvironment(spec: EpisodeSpec, environment?: EpisodeEnvironment): void {
  if (spec.benchmark && (!environment || environment.caseId !== spec.benchmark.caseId)) {
    throw new Error(`Case ${spec.benchmark.caseId} requires its deterministic desk environment.`);
  }
}
