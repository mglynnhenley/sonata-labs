import type { EpisodeRun, RunCost } from "@sonata/core";
import { aggregate, summarizeRun, type BenchmarkAggregate, type CellResult } from "./aggregate";
import type { BenchmarkMatrix, BenchmarkPlan, Cell } from "./plan";
import { readRunArtifact, writeReport, writeRunArtifact } from "./store";

// Executing a plan. The loop is short; the constraints around it are the content.

/**
 * What one cell's episode produced.
 *
 * `cost` is an override for the case `EpisodeRun` cannot express: a run that died
 * before a verdict existed still spent money, and a budget that ignores crashes
 * is not a budget. When a verdict is present its own cost wins, since that is
 * summed from OpenRouter's per-call `usage.cost`.
 */
export interface EpisodeOutcome {
  run: EpisodeRun;
  cost?: RunCost;
}

/**
 * The seam the runner is written against — the engine's tick loop, injected.
 *
 * Injected rather than imported so this package can be tested with no key, no
 * network and no twins listening on localhost, and so the engine's loop stays
 * swappable without touching the matrix logic. @sonata/engine is the intended
 * provider; the caller wires the two together.
 */
export type RunEpisode = (cell: Cell, ctx: { signal?: AbortSignal }) => Promise<EpisodeOutcome>;

export type BenchmarkEvent =
  | { kind: "resumed"; cell: Cell; result: CellResult }
  | { kind: "cell-start"; cell: Cell; done: number; total: number }
  | { kind: "cell-done"; cell: Cell; result: CellResult }
  | { kind: "cell-failed"; cell: Cell; error: string }
  | { kind: "stopped"; reason: StopReason; spentUsd: number };

export type StopReason = "budget" | "aborted";

export interface RunOptions {
  /** Where cell artifacts and the aggregate are written. */
  dir: string;
  run: RunEpisode;
  /** Stop before starting a cell once this much has been spent. */
  budgetUsd?: number;
  signal?: AbortSignal;
  onEvent?: (event: BenchmarkEvent) => void;
  /** Injected so a report is byte-comparable in tests. */
  now?: () => number;
}

export interface BenchmarkReport {
  matrix: BenchmarkMatrix;
  startedAt: number;
  endedAt: number;
  /** Every cell of the matrix that has a result, resumed ones included. */
  results: CellResult[];
  aggregate: BenchmarkAggregate;
  /** Set when the matrix did not finish. The report is still written. */
  stopped?: { reason: StopReason; spentUsd: number };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a plan and write everything it produces.
 *
 * CELLS RUN STRICTLY ONE AT A TIME, and that is a correctness constraint rather
 * than politeness towards the provider. The three twins each hold ONE mutable
 * world behind a shared sandbox API: an episode seeds that world at tick 0 and
 * mutates it for the rest of the day. Two episodes in flight would seed over each
 * other mid-run, interleave their audit rows, and hand each agent a mailbox
 * containing another model's replies. There is no per-run isolation to parallelise
 * against, so `await` inside the loop is load-bearing — do not turn this into a
 * `Promise.all` without giving every cell its own set of twins first.
 *
 * A cell that throws is recorded and the loop continues: one model that 400s on
 * one scenario must not cost a sixty-cell matrix its other fifty-nine. No artifact
 * is written for a failed cell, so resuming retries it — which is what you want,
 * because the usual cause is transient.
 */
export async function runBenchmark(plan: BenchmarkPlan, opts: RunOptions): Promise<BenchmarkReport> {
  const now = opts.now ?? Date.now;
  const emit = (e: BenchmarkEvent) => opts.onEvent?.(e);
  const startedAt = now();

  const results: CellResult[] = [];
  let spentUsd = 0;

  // Cells finished in an earlier session still belong in the table, so their
  // artifacts are read back rather than left out — a resumed benchmark must
  // aggregate the whole matrix, not just the part that ran today.
  for (const cell of plan.done) {
    const run = readRunArtifact(opts.dir, cell.runId);
    if (!run) continue; // vanished or corrupt since planning: it will simply re-run next time
    const result = summarizeRun(cell, run);
    results.push(result);
    spentUsd += result.cost.usd;
    emit({ kind: "resumed", cell, result });
  }

  let stopped: { reason: StopReason; spentUsd: number } | undefined;

  for (const cell of plan.pending) {
    if (opts.signal?.aborted) {
      stopped = { reason: "aborted", spentUsd };
      break;
    }
    // Checked before the call, not after: the check cannot un-spend, so the only
    // useful moment to make it is while the money is still in the account.
    if (opts.budgetUsd !== undefined && spentUsd >= opts.budgetUsd) {
      stopped = { reason: "budget", spentUsd };
      break;
    }

    emit({ kind: "cell-start", cell, done: results.length, total: plan.cells.length });
    const cellStartedAt = now();

    try {
      const outcome = await opts.run(cell, { signal: opts.signal });
      const result = summarizeRun(cell, outcome.run, {
        durationMs: Math.max(0, now() - cellStartedAt),
        ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
      });
      writeRunArtifact(opts.dir, outcome.run);
      results.push(result);
      spentUsd += result.cost.usd;
      emit({ kind: "cell-done", cell, result });
    } catch (err) {
      const message = errorText(err);
      // A cell that threw produced no result — not a zero. The row exists so the
      // matrix can say a run was attempted and what it cost; every number on it
      // is absent, because nothing was measured.
      results.push({
        runId: cell.runId,
        scenarioId: cell.scenarioId,
        model: cell.model,
        seed: cell.seed,
        status: "failed",
        score: null,
        autonomy: null,
        outcome: null,
        cost: { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 },
        ticks: 0,
        durationMs: Math.max(0, now() - cellStartedAt),
        failureModes: [],
        error: message,
      });
      emit({ kind: "cell-failed", cell, error: message });
    }
  }

  if (stopped) emit({ kind: "stopped", reason: stopped.reason, spentUsd: stopped.spentUsd });

  const report: BenchmarkReport = {
    matrix: plan.matrix,
    startedAt,
    endedAt: now(),
    results,
    aggregate: aggregate(plan.matrix, results),
    ...(stopped ? { stopped } : {}),
  };
  // Written even when the matrix stopped early: a partial table is the thing you
  // look at to decide whether to raise the budget.
  writeReport(opts.dir, report);
  return report;
}
