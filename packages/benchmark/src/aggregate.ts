import type { EpisodeRun, RunCost } from "@sonata/core";
import type { BenchmarkMatrix, Cell } from "./plan";

// Turning runs into the numbers the article quotes. Pure and deterministic: same
// cell results in, same aggregate out, no clock, no disk, no key. That matters
// because the table is the claim — if regenerating it from the saved artifacts
// produced a different number, there would be nothing to publish.

/** One cell's outcome, flattened off its artifact. The unit of aggregation. */
export interface CellResult {
  runId: string;
  scenarioId: string;
  model: string;
  seed: number;
  /** `failed` covers both a crashed run and one the engine ended badly. */
  status: "done" | "failed";
  /** Weighted fraction of the checklist that passed, 0..1. */
  score: number;
  /** How much got done without a human stepping in, 0..1 — the headline. */
  autonomy: number;
  outcome: "pass" | "partial" | "fail";
  cost: RunCost;
  ticks: number;
  /** Wall-clock, for the "how long does a matrix take" question. */
  durationMs: number;
  /**
   * Catalog mode ids the judge found, deduped. Frequency is counted per RUN, not
   * per finding: "over-escalated fired in 6 of 20 runs" is a number a reader can
   * hold, whereas "fired 31 times" mostly measures how chatty the judge was.
   */
  failureModes: string[];
  error?: string;
}

const ZERO_COST: RunCost = { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 };

/**
 * Flatten a finished episode into its row.
 *
 * A run with no verdict scores zero rather than being dropped: a model that
 * crashed on a scenario failed that scenario, and quietly excluding it would
 * flatter exactly the models that fell over.
 */
export function summarizeRun(
  cell: Cell,
  run: EpisodeRun,
  opts: { durationMs?: number; cost?: RunCost } = {},
): CellResult {
  const verdict = run.verdict;
  const modes = verdict?.judge?.findings.map((f) => f.mode) ?? [];
  const durationMs =
    opts.durationMs ?? (run.endedAt === null ? 0 : Math.max(0, run.endedAt - run.startedAt));

  return {
    runId: run.runId,
    scenarioId: cell.scenarioId,
    model: cell.model,
    seed: cell.seed,
    status: run.status === "done" ? "done" : "failed",
    score: verdict?.score ?? 0,
    autonomy: verdict?.autonomy ?? 0,
    outcome: verdict?.outcome ?? "fail",
    // `verdict.cost` is summed from OpenRouter's own `usage.cost` per call, so
    // the override is only for runs that died before a verdict existed.
    cost: verdict?.cost ?? opts.cost ?? ZERO_COST,
    ticks: run.ticks.length,
    durationMs,
    failureModes: [...new Set(modes)].sort(),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

/** One model on one scenario, across every seed. The cells of the main table. */
export interface ScenarioStats {
  scenarioId: string;
  episodes: number;
  meanAutonomy: number;
  meanScore: number;
  /** Share of episodes whose verdict was `pass`, 0..1. */
  successRate: number;
  /**
   * Variance of autonomy across the seeds, divided by n rather than n-1: these
   * are all the seeds that ran, not a sample of an infinite population, so this
   * describes the spread we actually observed. 0 with a single seed.
   */
  autonomyVariance: number;
  autonomyStdDev: number;
  meanCostUsd: number;
  failed: number;
}

export interface ModeFrequency {
  mode: string;
  /** Runs in which the judge found this mode at least once. */
  runs: number;
  /** `runs` over the model's episodes, 0..1. */
  rate: number;
}

export interface ModelAggregate {
  model: string;
  episodes: number;
  meanAutonomy: number;
  meanScore: number;
  successRate: number;
  meanCostUsd: number;
  totalCostUsd: number;
  meanDurationMs: number;
  /** Most frequent first, then alphabetical — a stable order for the table. */
  failureModes: ModeFrequency[];
  /**
   * Mean of the per-scenario autonomy variances. Read it as reproducibility: a
   * model with a high mean and a high seed variance is a model that got lucky,
   * and quoting only the mean would hide that.
   */
  seedVariance: number;
  byScenario: Record<string, ScenarioStats>;
  failed: number;
}

export interface BenchmarkAggregate {
  benchmarkId: string;
  /** Column order for the table — from the matrix, so an all-failed scenario still shows. */
  scenarioIds: string[];
  seeds: number[];
  episodes: number;
  failed: number;
  totalCostUsd: number;
  /** Row order: best mean autonomy first. Ties break alphabetically. */
  byModel: ModelAggregate[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population variance — see `ScenarioStats.autonomyVariance` for why not n-1. */
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

function statsFor(scenarioId: string, rows: CellResult[]): ScenarioStats {
  const autonomies = rows.map((r) => r.autonomy);
  const v = variance(autonomies);
  return {
    scenarioId,
    episodes: rows.length,
    meanAutonomy: mean(autonomies),
    meanScore: mean(rows.map((r) => r.score)),
    successRate: rows.length === 0 ? 0 : rows.filter((r) => r.outcome === "pass").length / rows.length,
    autonomyVariance: v,
    autonomyStdDev: Math.sqrt(v),
    meanCostUsd: mean(rows.map((r) => r.cost.usd)),
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

function modeFrequencies(rows: CellResult[]): ModeFrequency[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const m of r.failureModes) counts.set(m, (counts.get(m) ?? 0) + 1);

  return [...counts.entries()]
    .map(([mode, runs]) => ({ mode, runs, rate: rows.length === 0 ? 0 : runs / rows.length }))
    .sort((a, b) => b.runs - a.runs || a.mode.localeCompare(b.mode));
}

function aggregateModel(model: string, rows: CellResult[], scenarioIds: string[]): ModelAggregate {
  const byScenario: Record<string, ScenarioStats> = {};
  const perScenarioVariance: number[] = [];

  for (const scenarioId of scenarioIds) {
    const cells = rows.filter((r) => r.scenarioId === scenarioId);
    // A scenario this model never ran gets no row at all: rendering it as 0.00
    // would read as "scored zero" rather than "not run", and the table is meant
    // to be readable without a footnote.
    if (cells.length === 0) continue;
    const s = statsFor(scenarioId, cells);
    byScenario[scenarioId] = s;
    if (cells.length > 1) perScenarioVariance.push(s.autonomyVariance);
  }

  const totalCostUsd = rows.reduce((sum, r) => sum + r.cost.usd, 0);
  return {
    model,
    episodes: rows.length,
    meanAutonomy: mean(rows.map((r) => r.autonomy)),
    meanScore: mean(rows.map((r) => r.score)),
    successRate: rows.length === 0 ? 0 : rows.filter((r) => r.outcome === "pass").length / rows.length,
    meanCostUsd: rows.length === 0 ? 0 : totalCostUsd / rows.length,
    totalCostUsd,
    meanDurationMs: mean(rows.map((r) => r.durationMs)),
    failureModes: modeFrequencies(rows),
    seedVariance: mean(perScenarioVariance),
    byScenario,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

/**
 * The table, as data. Rows are ordered best-first because the article's first
 * question is "which model won"; columns keep the matrix's authored order because
 * scenarios tell a story in sequence and re-sorting them by difficulty would
 * scramble it.
 *
 * Results for models outside the matrix are still aggregated — a matrix can be
 * widened between sessions, and the artifacts from the narrower one are not
 * suddenly worthless.
 */
export function aggregate(matrix: BenchmarkMatrix, results: CellResult[]): BenchmarkAggregate {
  const models = [...new Set([...matrix.models, ...results.map((r) => r.model)])];
  const scenarioIds = [...new Set([...matrix.scenarioIds, ...results.map((r) => r.scenarioId)])];

  const byModel = models
    .map((m) => aggregateModel(m, results.filter((r) => r.model === m), scenarioIds))
    .filter((m) => m.episodes > 0)
    .sort((a, b) => b.meanAutonomy - a.meanAutonomy || a.model.localeCompare(b.model));

  return {
    benchmarkId: matrix.id,
    scenarioIds,
    seeds: [...matrix.seeds],
    episodes: results.length,
    failed: results.filter((r) => r.status === "failed").length,
    totalCostUsd: results.reduce((sum, r) => sum + r.cost.usd, 0),
    byModel,
  };
}
