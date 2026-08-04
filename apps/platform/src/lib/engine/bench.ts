import path from "node:path";
import {
  estimatePlan,
  listRunIds,
  planMatrix,
  runBenchmark,
  type BenchmarkEvent,
  type BenchmarkMatrix,
  type BenchmarkPlan,
  type BenchmarkReport,
  type Cell,
  type EpisodeOutcome,
  type ModelPrice,
  type PlanEstimate,
} from "@sonata/benchmark";
import { MODEL_CATALOG } from "../models";
import { getSettings } from "../settings";
import { cancel, startEpisode, whenDone } from "./episode";
import { describeScenario, shippedIds } from "./scenarios";

// The matrix, wired to the same run path as the dashboard's Start button.
//
// @sonata/benchmark owns the arithmetic — planning, resuming, pricing,
// aggregating — and reaches an episode through an injected port. This file is
// that port and nothing else: one function that turns a cell into a run through
// `startEpisode`, so a benchmark row and a run someone started by hand are the
// same thing scored the same way.

/**
 * The default rows: one model per vendor, cheap enough to run the whole matrix
 * in an evening. `--models` replaces this wholesale.
 */
export const DEFAULT_BENCH_MODELS: readonly string[] = [
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.4",
  "google/gemini-3.5-flash",
];

/**
 * One id, so re-running `sonata bench` resumes rather than starting again. Cell
 * ids are derived from it, and a cell already on disk is skipped.
 */
export const DEFAULT_BENCHMARK_ID = "sonata";

export function benchDir(): string {
  return process.env.SONATA_BENCH_DIR ?? path.join(process.cwd(), "data", "benchmarks");
}

/** The dashboard's price list, in the shape the estimator wants. */
function prices(): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const model of MODEL_CATALOG) {
    out[model.id] = { inputPerMTok: model.inputUsd, outputPerMTok: model.outputUsd };
  }
  return out;
}

export interface BenchOptions {
  id?: string;
  /** Scenario ids or titles. Defaults to the five days the product ships with. */
  scenarios?: string[];
  models?: string[];
  seeds?: number[];
  dir?: string;
  /** Stop before starting a cell once this much has been spent. */
  budgetUsd?: number;
  judge?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: BenchmarkEvent) => void;
}

export interface PlannedBench {
  plan: BenchmarkPlan;
  estimate: PlanEstimate;
  /** Scenario id → title, for anything that prints the matrix. */
  titles: Record<string, string>;
}

function matrixFor(opts: BenchOptions): { matrix: BenchmarkMatrix; titles: Record<string, string>; ticks: Record<string, number> } {
  // The shipped five are the suite the published table is built from, so they
  // are the default even when the user has scenarios of their own — those are a
  // different question, and `--scenarios` is how you ask it.
  const wanted = opts.scenarios?.length ? opts.scenarios : shippedIds();
  if (wanted.length === 0) throw new Error("No scenarios to benchmark.");

  const titles: Record<string, string> = {};
  const ticks: Record<string, number> = {};
  // Described, not resolved: planning must not be the thing that writes five
  // shipped scenarios into a store the user never asked to fill.
  const scenarioIds = wanted.map((query) => {
    const brief = describeScenario(query);
    titles[brief.id] = brief.title;
    ticks[brief.id] = brief.ticks;
    return brief.id;
  });

  return {
    matrix: {
      id: opts.id?.trim() || DEFAULT_BENCHMARK_ID,
      scenarioIds,
      models: opts.models?.length ? opts.models : [...DEFAULT_BENCH_MODELS],
      seeds: opts.seeds?.length ? opts.seeds : [0],
    },
    titles,
    ticks,
  };
}

/**
 * Expand the matrix and price it, without running anything. `--dry-run` prints
 * this — a benchmark is hours of billable calls, and the number it will cost
 * belongs in front of the user before the first one, not after the last.
 */
export function planBench(opts: BenchOptions = {}): PlannedBench {
  const { matrix, titles, ticks } = matrixFor(opts);
  const dir = opts.dir ?? benchDir();
  const plan = planMatrix(matrix, listRunIds(dir));
  const settings = getSettings();
  return {
    plan,
    estimate: estimatePlan(plan, {
      ticksByScenario: ticks,
      prices: prices(),
      harnessModel: settings.models.director,
    }),
    titles,
  };
}

/** One cell: a whole simulated day, run exactly as the dashboard would run it. */
async function runCell(
  cell: Cell,
  ctx: { signal?: AbortSignal },
  opts: BenchOptions,
): Promise<EpisodeOutcome> {
  const view = startEpisode({
    episodeId: cell.scenarioId,
    model: cell.model,
    seed: cell.seed,
    // Deterministic, and the resume key: an artifact under this name is what
    // tells the next session this cell is done.
    runId: cell.runId,
    ...(opts.judge === undefined ? {} : { judge: opts.judge }),
  });

  const stop = () => void cancel(view.runId);
  ctx.signal?.addEventListener("abort", stop, { once: true });
  try {
    const done = whenDone(view.runId);
    if (!done) throw new Error(`run ${view.runId} was dropped before it started`);
    const run = await done;
    // A run that died before a verdict still spent money, and a budget that
    // ignores crashes is not a budget.
    return { run, ...(run.verdict ? { cost: run.verdict.cost } : {}) };
  } finally {
    ctx.signal?.removeEventListener("abort", stop);
  }
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchmarkReport> {
  const { plan } = planBench(opts);
  const dir = opts.dir ?? benchDir();
  return runBenchmark(plan, {
    dir,
    run: (cell, ctx) => runCell(cell, ctx, opts),
    ...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}
