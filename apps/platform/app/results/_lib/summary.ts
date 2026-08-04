import {
  getFailureMode,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type RunStatus,
  type Severity,
} from "@sonata/core";

// Pure projections of a run artifact: the row the results index shows, the pivot
// the article's table is, and the formatters both use. No filesystem, no React —
// so a client component can import this and a route handler can too.

export type Outcome = "pass" | "partial" | "fail";

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
  autonomy: number | null;
  costUsd: number | null;
  ticks: number;
  judged: boolean;
  failures: FailureChip[];
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "major", "minor"];

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

export function summarizeRun(run: EpisodeRun): RunSummary {
  const verdict = run.verdict;
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
    autonomy: verdict ? verdict.autonomy : null,
    costUsd: verdict ? verdict.cost.usd : null,
    ticks: run.ticks.length,
    judged: Boolean(verdict?.judge),
    failures: failureChips(verdict?.judge ?? null),
  };
}

/** A run the benchmark can count: it reached a verdict, however bad. */
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
  return { scenarios, rows };
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
  return "Not scored";
}

export const SEVERITY_BADGE: Record<Severity, "failed" | "warning" | "neutral"> = {
  critical: "failed",
  major: "warning",
  minor: "neutral",
};
