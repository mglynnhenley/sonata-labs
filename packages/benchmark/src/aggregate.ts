import { runExecution, type EpisodeRun, type RunCost, type VerdictOutcome } from "@sonata/core";
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
  /**
   * Weighted fraction of the checklist that passed, 0..1 — NULL when the run
   * never executed. Null rather than 0 because these three fields are what every
   * mean in this file is taken over, and a run that did not happen has to be
   * absent from them, not a zero pulling them down (or, worse, a 0.25 pulling
   * them up off negative criteria nobody earned).
   */
  score: number | null;
  /** How much got done without a human stepping in, 0..1 — the headline. */
  autonomy: number | null;
  outcome: VerdictOutcome | null;
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
 * A run with no verdict is kept as a row and dropped from the numbers: the cell
 * still says a run happened and still carries what it cost, but it contributes
 * no score, no autonomy and no outcome, because it produced none. Scoring it as
 * a zero would be a claim about the model; leaving the row out entirely would
 * flatter exactly the models that fell over. Neither is what happened.
 */
export function summarizeRun(
  cell: Cell,
  run: EpisodeRun,
  opts: { durationMs?: number; cost?: RunCost } = {},
): CellResult {
  // The verdict is trusted only if the run was in a state to have earned one —
  // an artifact written by an older build may carry a farmed one.
  const verdict = runExecution(run).executed ? run.verdict : null;
  const modes = verdict?.judge?.findings.map((f) => f.mode) ?? [];
  const durationMs =
    opts.durationMs ?? (run.endedAt === null ? 0 : Math.max(0, run.endedAt - run.startedAt));

  return {
    runId: run.runId,
    scenarioId: cell.scenarioId,
    model: cell.model,
    seed: cell.seed,
    status: run.status === "done" ? "done" : "failed",
    score: verdict?.score ?? null,
    autonomy: verdict?.autonomy ?? null,
    outcome: verdict?.outcome ?? null,
    // `verdict.cost` is summed from OpenRouter's own `usage.cost` per call, so
    // the override is only for runs that died before a verdict existed.
    cost: run.verdict?.cost ?? opts.cost ?? ZERO_COST,
    ticks: run.ticks.length,
    durationMs,
    failureModes: [...new Set(modes)].sort(),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

/** A cell the table may quote: it executed and reached a verdict. */
export function isScoredCell(row: CellResult): boolean {
  return row.outcome !== null;
}

// Every mean below is taken over SCORED cells only, and is null when there are
// none. `episodes` counts what was attempted, `scored` what can be quoted, and
// the gap between them is a fact about the harness rather than about the model —
// which is why it is carried rather than smoothed away.

/** One model on one scenario, across every seed. The cells of the main table. */
export interface ScenarioStats {
  scenarioId: string;
  episodes: number;
  /** Episodes that produced a result. The denominator for the means below. */
  scored: number;
  meanAutonomy: number | null;
  meanScore: number | null;
  /** Share of scored episodes whose verdict was `pass`, 0..1; null if none. */
  successRate: number | null;
  /**
   * Variance of autonomy across the seeds, divided by n rather than n-1: these
   * are all the seeds that ran, not a sample of an infinite population, so this
   * describes the spread we actually observed. 0 with a single seed.
   */
  autonomyVariance: number;
  autonomyStdDev: number;
  /** Mean spend per episode ATTEMPTED — a crashed cell still cost money. */
  meanCostUsd: number;
  failed: number;
}

export interface ModeFrequency {
  mode: string;
  /** Runs in which the judge found this mode at least once. */
  runs: number;
  /** `runs` over the model's scored episodes, 0..1. */
  rate: number;
}

export interface ModelAggregate {
  model: string;
  episodes: number;
  /** Episodes that produced a result. */
  scored: number;
  /** Episodes that did not — crashed, stopped, or the agent never acted. */
  unscored: number;
  meanAutonomy: number | null;
  meanScore: number | null;
  successRate: number | null;
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
  /** Episodes that produced a result, and the ones that produced none. */
  scored: number;
  unscored: number;
  failed: number;
  totalCostUsd: number;
  /** Row order: best mean autonomy first. Ties break alphabetically. */
  byModel: ModelAggregate[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The mean of what is known, or null when nothing is. Never a zero standing in. */
function meanOrNull(xs: Array<number | null>): number | null {
  const known = xs.filter((x): x is number => x !== null);
  return known.length === 0 ? null : mean(known);
}

/** Population variance — see `ScenarioStats.autonomyVariance` for why not n-1. */
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

function statsFor(scenarioId: string, rows: CellResult[]): ScenarioStats {
  const scored = rows.filter(isScoredCell);
  // Spread across the seeds that produced a number. A cell that never ran has no
  // autonomy to be far from the mean, and counting it as 0 would report a wobble
  // the models never had.
  const v = variance(scored.map((r) => r.autonomy ?? 0));
  return {
    scenarioId,
    episodes: rows.length,
    scored: scored.length,
    meanAutonomy: meanOrNull(rows.map((r) => r.autonomy)),
    meanScore: meanOrNull(rows.map((r) => r.score)),
    successRate:
      scored.length === 0 ? null : scored.filter((r) => r.outcome === "pass").length / scored.length,
    autonomyVariance: v,
    autonomyStdDev: Math.sqrt(v),
    meanCostUsd: mean(rows.map((r) => r.cost.usd)),
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

function modeFrequencies(rows: CellResult[]): ModeFrequency[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const m of r.failureModes) counts.set(m, (counts.get(m) ?? 0) + 1);
  // Only a scored run could have been judged, so only scored runs are the
  // denominator: "fired in 3 of 5" must not quietly mean 3 of 5 attempts.
  const scored = rows.filter(isScoredCell).length;

  return [...counts.entries()]
    .map(([mode, runs]) => ({ mode, runs, rate: scored === 0 ? 0 : runs / scored }))
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
    if (s.scored > 1) perScenarioVariance.push(s.autonomyVariance);
  }

  const scored = rows.filter(isScoredCell);
  const totalCostUsd = rows.reduce((sum, r) => sum + r.cost.usd, 0);
  return {
    model,
    episodes: rows.length,
    scored: scored.length,
    unscored: rows.length - scored.length,
    meanAutonomy: meanOrNull(rows.map((r) => r.autonomy)),
    meanScore: meanOrNull(rows.map((r) => r.score)),
    successRate:
      scored.length === 0 ? null : scored.filter((r) => r.outcome === "pass").length / scored.length,
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
    // A model with nothing to quote sorts last rather than first: an unknown is
    // not a win, and -1 is below every real autonomy.
    .sort(
      (a, b) =>
        (b.meanAutonomy ?? -1) - (a.meanAutonomy ?? -1) || a.model.localeCompare(b.model),
    );

  const scored = results.filter(isScoredCell).length;
  return {
    benchmarkId: matrix.id,
    scenarioIds,
    seeds: [...matrix.seeds],
    episodes: results.length,
    scored,
    unscored: results.length - scored,
    failed: results.filter((r) => r.status === "failed").length,
    totalCostUsd: results.reduce((sum, r) => sum + r.cost.usd, 0),
    byModel,
  };
}
