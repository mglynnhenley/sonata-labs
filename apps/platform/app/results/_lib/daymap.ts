import { getFailureMode, type CriterionResult, type EpisodeJudgeReport, type Severity } from "@sonata/core";
import type { Moment } from "./moments";

// The day as one row of columns, so "where did it go wrong" is a place on a chart
// rather than a paragraph to parse.
//
// Everything here is derived from artifacts the page already holds — the moments
// the replay is built from, the judge's findings and the checklist. Nothing is
// read off disk and nothing is asked of a model: the chart is a second view of
// the same facts the sections below it state in words, which is the only way a
// picture is allowed to be on this page.
//
// A finding names either a tick or a set of step numbers, and often both. A step
// number is the more precise of the two, so it wins — `findings.tick` on an older
// report can be the tick the judge was thinking about rather than the one the
// step is actually in.

/** One tick of the day. */
export interface DayColumn {
  tick: number;
  simTimeISO: string;
  /** Tool calls the agent made in this tick — the height of the column. */
  calls: number;
  /** How many of those changed something. A tick with none only read. */
  changes: number;
  /** It handed the job back to a human here. */
  escalated: boolean;
  /** Judge findings that land on this tick, worst first. */
  findings: Array<{ label: string; severity: Severity }>;
  /** Criteria the checkers failed here. */
  failed: string[];
}

export interface DayMap {
  columns: DayColumn[];
  /** Tallest column, so every bar can be drawn as a share of it. Never 0. */
  peak: number;
  /** Ticks carrying at least one finding — what the marker rail draws. */
  flagged: number[];
  /** Every tick where something changed. The "it landed" story. */
  productive: number;
  /** Ticks with tool calls but nothing to show for them. */
  spentIdle: number;
  totalFindings: number;
}

const RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

/** Step number → the tick it happened in. A finding's `seq` is resolved through this. */
function tickBySeq(moments: Moment[]): Map<number, number> {
  const index = new Map<number, number>();
  for (const moment of moments) {
    if (moment.seq !== undefined && !index.has(moment.seq)) index.set(moment.seq, moment.tick);
  }
  return index;
}

/**
 * Which tick a finding belongs on.
 *
 * Its steps first: a step number is a fact about the trace, and the judge's own
 * `tick` is its recollection of where that step was. They usually agree. When they
 * do not, a marker under the wrong column is worse than a marker under a column
 * the reader can click into and check.
 */
function tickOfFinding(
  finding: { tick?: number; seq?: number[] },
  bySeq: Map<number, number>,
): number | null {
  for (const seq of finding.seq ?? []) {
    const tick = bySeq.get(seq);
    if (tick !== undefined) return tick;
  }
  return finding.tick ?? null;
}

export function buildDayMap(
  moments: Moment[],
  judge: EpisodeJudgeReport | null,
  checklist: readonly CriterionResult[] = [],
): DayMap {
  const byTick = new Map<number, DayColumn>();

  const column = (tick: number, simTimeISO = ""): DayColumn => {
    let existing = byTick.get(tick);
    if (!existing) {
      existing = { tick, simTimeISO, calls: 0, changes: 0, escalated: false, findings: [], failed: [] };
      byTick.set(tick, existing);
    }
    // A tick invented by a finding has no clock of its own until a moment fills it.
    if (!existing.simTimeISO && simTimeISO) existing.simTimeISO = simTimeISO;
    return existing;
  };

  for (const moment of moments) {
    const at = column(moment.tick, moment.simTimeISO);
    if (moment.step?.kind === "tool") at.calls++;
    if (moment.isMutation) at.changes++;
    if (moment.step?.kind === "escalation") at.escalated = true;
  }

  const bySeq = tickBySeq(moments);

  for (const finding of judge?.findings ?? []) {
    const tick = tickOfFinding(finding, bySeq);
    if (tick === null) continue;
    // An id off disk can predate a catalog rename; the raw id still names it.
    const label = getFailureMode(finding.mode)?.label ?? finding.mode;
    column(tick).findings.push({ label, severity: finding.severity });
  }
  for (const finding of judge?.otherFindings ?? []) {
    if (finding.tick === undefined) continue;
    column(finding.tick).findings.push({ label: finding.label, severity: finding.severity });
  }

  // Only FAILED criteria. One nothing could decide is not a failure and must never
  // be drawn as one — that is the same rule the checklist itself follows.
  for (const criterion of checklist) {
    if (criterion.status !== "failed" || criterion.tick === undefined) continue;
    column(criterion.tick).failed.push(criterion.description);
  }

  const columns = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  for (const c of columns) c.findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

  return {
    columns,
    peak: Math.max(1, ...columns.map((c) => c.calls)),
    flagged: columns.filter((c) => c.findings.length > 0 || c.failed.length > 0).map((c) => c.tick),
    productive: columns.filter((c) => c.changes > 0).length,
    spentIdle: columns.filter((c) => c.calls > 0 && c.changes === 0).length,
    totalFindings: columns.reduce((n, c) => n + c.findings.length, 0),
  };
}

/** Worth drawing only when there is a day in it. One column is a bar, not a chart. */
export function hasDayShape(map: DayMap): boolean {
  return map.columns.length > 1;
}

/** The severity a column is drawn at — its worst. */
export function columnSeverity(column: DayColumn): Severity | null {
  if (column.findings.length > 0) return column.findings[0].severity;
  return column.failed.length > 0 ? "major" : null;
}
