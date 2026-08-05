import { getFailureMode } from "@sonata/core";
import type { BenchmarkAggregate, ModelAggregate } from "./aggregate";
import { formatUsd } from "./estimate";

// The table the article is built around: models down the side, scenarios across
// the top, autonomy in the cells.
//
// Pure string work over a finished aggregate. Every option here changes a LABEL
// and none of them changes a number, which is the point: the thing that gets
// published cannot quietly disagree with the thing that was measured, and
// regenerating the table from the saved artifacts a month later reproduces it
// character for character.

export interface TableOptions {
  /** Human column headings, by scenario id. The id is used for anything missing. */
  scenarioLabels?: Record<string, string>;
  /** Shorter row headings, by model slug. */
  modelLabels?: Record<string, string>;
  /**
   * Append the across-seeds standard deviation to each cell. On by default: a
   * bare 0.82 invites the reader to believe the third decimal, and the whole
   * reason for running seeds was to be able to show the wobble.
   */
  spread?: boolean;
  /** Printed where a model never ran a scenario. Not the same as scoring zero. */
  missing?: string;
}

type Align = "left" | "right";

/** A cell containing a bare `|` would end the column early. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * A padded GitHub-flavoured markdown table. The padding is cosmetic to a
 * renderer and load-bearing to a human: this output is read as often in a diff
 * as it is on a page.
 */
function mdTable(headers: string[], rows: string[][], align: Align[]): string {
  const grid = [headers, ...rows].map((r) => r.map((c) => escapeCell(c)));
  // 3 is the narrowest a separator cell can be and still be legal markdown.
  const widths = headers.map((_, i) => Math.max(3, ...grid.map((r) => (r[i] ?? "").length)));

  const pad = (c: string, i: number): string =>
    align[i] === "right" ? c.padStart(widths[i]) : c.padEnd(widths[i]);
  const line = (cells: string[]): string => `| ${cells.map(pad).join(" | ")} |`;

  const divider = widths.map((w, i) =>
    align[i] === "right" ? `${"-".repeat(w - 1)}:` : `:${"-".repeat(w - 1)}`,
  );

  return [
    line(headers),
    `| ${divider.join(" | ")} |`,
    ...grid.slice(1).map((r) => line(headers.map((_, i) => r[i] ?? ""))),
  ].join("\n");
}

/**
 * 0..1 as two decimals. Two, because seed noise lives in the second one.
 *
 * A null is a dash, and that is the whole contract of this file: the table may
 * print a number we measured or say that we did not, and it may never print a
 * 0.00 that means "no run". A reader cannot tell those apart, and the first one
 * who tries is holding the article.
 */
export function formatScore(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

/** 0..1 as a whole percentage — "67%", never "66.7%". */
export function formatPct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

function label(id: string, labels: Record<string, string> | undefined): string {
  return labels?.[id] ?? id;
}

/**
 * The main table: one row per model, one column per scenario, mean autonomy in
 * the cell. Row order is the aggregate's (best first) and column order is the
 * matrix's authored order — see `aggregate`, which owns both decisions.
 */
export function renderMatrixTable(agg: BenchmarkAggregate, opts: TableOptions = {}): string {
  const spread = opts.spread ?? true;
  const missing = opts.missing ?? "—";

  const headers = [
    "Model",
    ...agg.scenarioIds.map((id) => label(id, opts.scenarioLabels)),
    "Mean",
  ];

  const rows = agg.byModel.map((m) => [
    label(m.model, opts.modelLabels),
    ...agg.scenarioIds.map((id) => {
      const s = m.byScenario[id];
      if (!s) return missing;
      // The ± is shown only where more than one seed SCORED: quoting "±0.00" on a
      // single episode would claim a reproducibility that was never tested.
      return spread && s.scored > 1
        ? `${formatScore(s.meanAutonomy)} ±${formatScore(s.autonomyStdDev)}`
        : formatScore(s.meanAutonomy);
    }),
    formatScore(m.meanAutonomy),
  ]);

  return mdTable(headers, rows, ["left", ...agg.scenarioIds.map((): Align => "right"), "right"]);
}

function topMode(m: ModelAggregate): string {
  const top = m.failureModes[0];
  if (!top) return "—";
  return `${getFailureMode(top.mode)?.label ?? top.mode} (${top.runs})`;
}

/**
 * The summary table: everything about a model that is not per-scenario. Cost per
 * episode sits next to autonomy on purpose — the interesting result is rarely
 * "the best model won", it is what the best model charged to win.
 */
export function renderSummaryTable(agg: BenchmarkAggregate, opts: TableOptions = {}): string {
  const headers = [
    "Model",
    "Episodes",
    // Scored is its own column rather than a footnote: it is the denominator of
    // the three numbers to its right, and a reader is entitled to see it.
    "Scored",
    "Autonomy",
    "Task success",
    "Cost/episode",
    "Seed variance",
    "Failed",
    "Top failure mode",
  ];

  const rows = agg.byModel.map((m) => [
    label(m.model, opts.modelLabels),
    String(m.episodes),
    String(m.scored),
    formatScore(m.meanAutonomy),
    formatPct(m.successRate),
    formatUsd(m.meanCostUsd),
    m.seedVariance.toFixed(4),
    String(m.failed),
    topMode(m),
  ]);

  return mdTable(headers, rows, [
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "left",
  ]);
}

/**
 * Failure modes down the side, models across the top, "runs it fired in" in the
 * cell. Counted per run rather than per finding — see `CellResult.failureModes`.
 * Modes nobody hit are omitted entirely: absence is the default, and a wall of
 * zeroes would bury the handful of rows that matter.
 */
export function renderFailureModeTable(agg: BenchmarkAggregate, opts: TableOptions = {}): string {
  const totals = new Map<string, number>();
  for (const m of agg.byModel) {
    for (const f of m.failureModes) totals.set(f.mode, (totals.get(f.mode) ?? 0) + f.runs);
  }
  const modes = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([mode]) => mode);

  if (modes.length === 0) return "_No catalogued failure modes were found._";

  const headers = ["Failure mode", ...agg.byModel.map((m) => label(m.model, opts.modelLabels))];
  const rows = modes.map((mode) => [
    getFailureMode(mode)?.label ?? mode,
    ...agg.byModel.map((m) => {
      const f = m.failureModes.find((x) => x.mode === mode);
      return f ? `${f.runs} (${formatPct(f.rate)})` : "·";
    }),
  ]);

  return mdTable(headers, rows, ["left", ...agg.byModel.map((): Align => "right")]);
}

/**
 * All three tables plus the one-line provenance the article needs underneath
 * them. This is the string that gets pasted into the post.
 */
export function renderReport(agg: BenchmarkAggregate, opts: TableOptions = {}): string {
  const dims =
    `${agg.byModel.length} model(s) x ${agg.scenarioIds.length} scenario(s) ` +
    `x ${agg.seeds.length} seed(s)`;
  // The provenance line has to carry the exclusion, or every number above it is
  // quoted without the one caveat that would let a reader check it.
  const unscored =
    agg.unscored > 0
      ? `, ${agg.unscored} of which never ran and are excluded from every number above`
      : "";

  return [
    `## ${agg.benchmarkId}`,
    "",
    "### Autonomy by scenario",
    "",
    renderMatrixTable(agg, opts),
    "",
    "### Summary",
    "",
    renderSummaryTable(agg, opts),
    "",
    "### Failure modes",
    "",
    renderFailureModeTable(agg, opts),
    "",
    `_${agg.episodes} episodes${unscored} — ${dims}. Total spend ${formatUsd(agg.totalCostUsd)}._`,
    "",
  ].join("\n");
}
