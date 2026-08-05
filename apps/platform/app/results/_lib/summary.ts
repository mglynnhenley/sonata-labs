import {
  getFailureMode,
  NO_RESULT,
  runExecution,
  scoreChecklist,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type RunStatus,
  type Severity,
  type VerdictOutcome,
} from "@sonata/core";

// Pure projections of a run artifact: the row the results index shows, the pivot
// the article's table is, and the formatters both use. No filesystem, no React —
// so a client component can import this and a route handler can too.

/**
 * Re-exported rather than re-spelled. This union used to be written out here, and
 * a fourth state added to the scorer could not reach the badge that renders it —
 * which is how "Passed" ended up over a run nothing had graded.
 */
export type Outcome = VerdictOutcome;

export interface FailureChip {
  /** Catalog id, or the free-form label for an uncatalogued finding. */
  mode: string;
  label: string;
  severity: Severity;
  /** Judge named it itself — it has no catalog id, and so no jump target. */
  uncatalogued: boolean;
}

export interface RunSummary {
  runId: string;
  specId: string;
  specTitle: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  /** Null while the run is still going. */
  durationMs: number | null;
  outcome: Outcome | null;
  score: number | null;
  /**
   * What `score` is a fraction OF. Carried beside the number, never derived at
   * the render site: "100%" off one of four criteria and "100%" off four of four
   * are different claims about a run, and the first one — a checklist whose every
   * `must` came back undecidable — is what the percentage alone was hiding.
   * Null exactly when `score` is.
   */
  coverage: { decided: number; total: number; undecidedMusts: number } | null;
  autonomy: number | null;
  costUsd: number | null;
  ticks: number;
  judged: boolean;
  failures: FailureChip[];
  /**
   * Why this run has no score, in the words to print. Null when it has one — so
   * a page never has to choose between rendering a 0 and rendering an empty card.
   */
  noResult: string | null;
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "major", "minor"];

// ---------------------------------------------------------------------------
// Names. Three numbers on this product's screens are fractions of something that
// passed, and two of them used to share the label "task success" — Home's, which
// is a share of RUNS, and the run page's, which is a share of ONE RUN'S
// CRITERIA. Same words, different denominators, adjacent pages: Home printed 0%
// while the run page printed 25% for the same day. They are named apart here, as
// constants rather than as strings in three components, because a shared label
// that lives in three files is a label that drifts back.
// ---------------------------------------------------------------------------

/** `EpisodeVerdict.score` — weighted share of ONE run's checklist that passed. */
export const CHECKLIST_LABEL = "Checklist score";
export const CHECKLIST_HINT = "Weighted share of this run's success criteria that passed.";

/** `RunStats.passRate` — share of finished RUNS whose every criterion passed. */
export const PASS_RATE_LABEL = "Runs passed";
export const PASS_RATE_HINT = "Finished runs where every criterion the day could decide passed.";

export function failureChips(judge: EpisodeJudgeReport | null): FailureChip[] {
  if (!judge) return [];
  // Catalogued and uncatalogued findings share a row shape on purpose: the judge
  // found both, one simply has no id yet, and burying it is how a taxonomy stops
  // growing. The dashed border is the whole distinction.
  const chips: FailureChip[] = [
    ...judge.findings.map((f) => ({
      // An id off disk can predate a catalog rename, so fall back to the raw id.
      mode: f.mode,
      label: getFailureMode(f.mode)?.label ?? f.mode,
      severity: f.severity,
      uncatalogued: false,
    })),
    ...judge.otherFindings.map((f) => ({
      mode: f.label,
      label: f.label,
      severity: f.severity,
      uncatalogued: true,
    })),
  ];
  return chips.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

function coverageOf(
  checklist: CriterionResult[],
): { decided: number; total: number; undecidedMusts: number } {
  const { decided, total, undecidedMusts } = scoreChecklist(checklist);
  return { decided, total, undecidedMusts };
}

export function summarizeRun(run: EpisodeRun): RunSummary {
  const execution = runExecution(run);
  // The artifact decides, not the file's own verdict: a run that never executed
  // is unscored even if an older writer left numbers on it.
  const verdict = execution.executed ? run.verdict : null;
  return {
    runId: run.runId,
    specId: run.specId,
    specTitle: run.specTitle,
    model: run.model,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null,
    outcome: verdict?.outcome ?? null,
    score: verdict ? verdict.score : null,
    // Recomputed from the saved rows rather than read off the verdict, so an
    // artifact written before the counts existed still shows them, and so the
    // denominator can never disagree with the checklist printed underneath it.
    coverage: verdict ? coverageOf(verdict.checklist) : null,
    autonomy: verdict ? verdict.autonomy : null,
    costUsd: verdict ? verdict.cost.usd : null,
    ticks: run.ticks.length,
    judged: Boolean(verdict?.judge),
    failures: failureChips(verdict?.judge ?? null),
    noResult: execution.reason,
  };
}

/**
 * A run an average may include.
 *
 * One test, and it is `summarizeRun`'s: a run that never executed has no score,
 * no autonomy and no outcome by the time it reaches here, so `outcome !== null`
 * is now exactly "this run produced a result". Re-deriving the rule here would
 * be a second definition of the population, which is the shape of the bug this
 * pass exists to remove — four runs that crashed before their first tick were
 * averaged into this table's headline beside a run with forty-five real actions.
 *
 * The runs LIST is unfiltered on purpose: a crashed run is a fact about the
 * harness and hiding it would be the worse lie. It just does not get a vote.
 */
export function isScored(run: RunSummary): boolean {
  return run.outcome !== null;
}

// ---------------------------------------------------------------------------
// Benchmark pivot — rows are models, columns are scenarios. This is the table
// the article prints, so it is built once here and rendered twice (HTML and,
// via `benchmarkMarkdown`, straight into the draft).
// ---------------------------------------------------------------------------

export interface BenchmarkCell {
  specId: string;
  runs: number;
  autonomy: number | null;
  score: number | null;
  costUsd: number | null;
  /** Where the cell leads. Doors, not dead ends. */
  latestRunId: string | null;
}

export interface BenchmarkRow {
  model: string;
  runs: number;
  cells: Record<string, BenchmarkCell>;
  meanAutonomy: number | null;
  meanScore: number | null;
  costPerEpisode: number | null;
  /** The failure mode this model hit most often, across every scenario. */
  topFailure: { label: string; count: number } | null;
}

export interface Benchmark {
  scenarios: Array<{ specId: string; title: string }>;
  rows: BenchmarkRow[];
  /**
   * Runs in scope that no average includes — they never finished their day. Shown
   * under the table, because a mean over a silently smaller population is the
   * same lie in the other direction.
   */
  excluded: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function defined(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

export function buildBenchmark(runs: RunSummary[]): Benchmark {
  const scored = runs.filter(isScored);

  const scenarios: Array<{ specId: string; title: string }> = [];
  for (const run of scored) {
    if (!scenarios.some((s) => s.specId === run.specId)) {
      scenarios.push({ specId: run.specId, title: run.specTitle });
    }
  }
  scenarios.sort((a, b) => a.title.localeCompare(b.title));

  const byModel = new Map<string, RunSummary[]>();
  for (const run of scored) {
    const bucket = byModel.get(run.model);
    if (bucket) bucket.push(run);
    else byModel.set(run.model, [run]);
  }

  const rows: BenchmarkRow[] = [...byModel.entries()].map(([model, modelRuns]) => {
    const cells: Record<string, BenchmarkCell> = {};
    for (const scenario of scenarios) {
      const cellRuns = modelRuns.filter((r) => r.specId === scenario.specId);
      if (cellRuns.length === 0) continue;
      cells[scenario.specId] = {
        specId: scenario.specId,
        runs: cellRuns.length,
        autonomy: mean(defined(cellRuns.map((r) => r.autonomy))),
        score: mean(defined(cellRuns.map((r) => r.score))),
        costUsd: mean(defined(cellRuns.map((r) => r.costUsd))),
        // Newest, because `scored` arrives newest first.
        latestRunId: cellRuns[0]?.runId ?? null,
      };
    }

    const counts = new Map<string, number>();
    for (const run of modelRuns) {
      // One run naming a mode twice is still one occurrence of that mode.
      for (const label of new Set(run.failures.map((f) => f.label))) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

    return {
      model,
      runs: modelRuns.length,
      cells,
      meanAutonomy: mean(defined(modelRuns.map((r) => r.autonomy))),
      meanScore: mean(defined(modelRuns.map((r) => r.score))),
      costPerEpisode: mean(defined(modelRuns.map((r) => r.costUsd))),
      topFailure: top ? { label: top[0], count: top[1] } : null,
    };
  });

  // Best autonomy first — the ranking the article leads with.
  rows.sort((a, b) => (b.meanAutonomy ?? -1) - (a.meanAutonomy ?? -1));
  return { scenarios, rows, excluded: runs.length - scored.length };
}

/** The same table as a Markdown block, ready to paste into the article draft. */
export function benchmarkMarkdown(benchmark: Benchmark): string {
  const header = [
    "Model",
    ...benchmark.scenarios.map((s) => s.title),
    "Mean autonomy",
    "Most common failure",
    "Cost / episode",
  ];
  const rows = benchmark.rows.map((row) => [
    row.model,
    ...benchmark.scenarios.map((s) => formatPercent(row.cells[s.specId]?.autonomy ?? null)),
    formatPercent(row.meanAutonomy),
    row.topFailure ? `${row.topFailure.label} (${row.topFailure.count})` : "none",
    formatUsd(row.costPerEpisode),
  ]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Formatters. One em dash for "we do not know", everywhere — a missing number
// must never render as a confident zero.
// ---------------------------------------------------------------------------

export const UNKNOWN = "—";

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? UNKNOWN : `${Math.round(value * 100)}%`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (value === 0) return "$0";
  if (value < 0.001) return "<$0.001";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return UNKNOWN;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

/** Absolute wall-clock date for a run, in the reader's own zone. */
export function formatWhen(ms: number): string {
  if (!ms) return UNKNOWN;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The company's own wall clock, e.g. "09:15". `simTimeISO` is absolute UTC, so
 * the day's offset has to be added back or a New York episode reads as 13:15.
 */
export function formatSimTime(iso: string, offsetMinutes = 0): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return UNKNOWN;
  const shifted = new Date(ms + offsetMinutes * 60_000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/** Which `Badge` status a run wears in a list. */
export function badgeStatus(run: {
  status: RunStatus;
  outcome: Outcome | null;
}): "running" | "passed" | "failed" | "pending" | "warning" | "neutral" {
  if (run.status === "running" || run.status === "judging") return "running";
  if (run.status === "queued") return "pending";
  if (run.status === "failed" || run.status === "aborted") return "failed";
  if (run.outcome === "pass") return "passed";
  if (run.outcome === "partial") return "warning";
  if (run.outcome === "fail") return "failed";
  // `inconclusive` lands here deliberately: grey, not amber. Amber sits between
  // green and red and would read as a grade — a middling one. This run has no
  // grade, and the badge has to say "not a result" rather than "a poor result".
  return "neutral";
}

export function outcomeLabel(run: { status: RunStatus; outcome: Outcome | null }): string {
  if (run.status === "running") return "Running";
  if (run.status === "judging") return "Judging";
  if (run.status === "queued") return "Queued";
  if (run.status === "aborted") return "Aborted";
  if (run.status === "failed") return "Errored";
  if (run.outcome === "pass") return "Passed";
  if (run.outcome === "partial") return "Partial";
  if (run.outcome === "fail") return "Failed";
  // Not "Not scored" and not "Unknown": the run happened and the agent did work,
  // and what is missing is the harness's ability to say whether the work was right.
  if (run.outcome === "inconclusive") return "Inconclusive";
  // A finished day with no outcome is a day the agent never worked. "No result"
  // rather than "Not scored": the second sounds like an oversight of ours.
  return NO_RESULT;
}

export const SEVERITY_BADGE: Record<Severity, "failed" | "warning" | "neutral"> = {
  critical: "failed",
  major: "warning",
  minor: "neutral",
};
