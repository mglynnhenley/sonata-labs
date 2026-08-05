import type { EpisodeRun, RunStatus, TickRecord } from "./types/run";

// WHETHER A RUN IS SCOREABLE AT ALL.
//
// Every checklist carries negative criteria — never handed the day back, left
// the forecast alone, did not escalate — and every one of them is true of an
// agent that did nothing. So a run that crashed before tick 0 passes them, earns
// their weight, and lands mid-table beside a run that did the work. No amount of
// arithmetic downstream fixes that: the run has no performance to report.
//
// So the question is asked before the scoring, once, here. A score is a claim
// about how well the agent did; a run that never executed supports only a claim
// about what we know, which is nothing. Such a run is written down with its
// score, autonomy and outcome ABSENT — null, never zero — so that no mean can
// quietly average it in and no page can print a number it does not have.

/** Tool calls across the day: the only evidence anything reached a twin. */
export function agentToolCalls(ticks: TickRecord[]): number {
  let calls = 0;
  for (const tick of ticks) {
    for (const step of tick.agentSteps) if (step.kind === "tool") calls += 1;
  }
  return calls;
}

export interface RunExecution {
  /** True when the run may carry a score. */
  executed: boolean;
  ticks: number;
  toolCalls: number;
  /** Why there is no score, in the words a page should print. Null when scored. */
  reason: string | null;
}

/** The badge an unscored run wears wherever a score would have gone. */
export const NO_RESULT = "No result";

/**
 * Did this run execute?
 *
 * Three ways to have not, and each is read off the artifact rather than
 * inferred: the day never finished, it finished with no ticks, or it ticked
 * through with the agent never touching a twin. A day stopped or crashed halfway
 * counts as unexecuted too — the afternoon's criteria never got their chance, so
 * scoring it against the whole checklist would measure the interruption.
 *
 * Thoughts and escalations deliberately do not count as acting. An agent that
 * only ever narrated left the twins exactly as it found them, which is the same
 * state a crash leaves them in.
 */
export function runExecution(run: { status: RunStatus; ticks: TickRecord[] }): RunExecution {
  const ticks = run.ticks.length;
  const toolCalls = agentToolCalls(run.ticks);
  const executed = run.status === "done" && ticks > 0 && toolCalls > 0;

  return {
    executed,
    ticks,
    toolCalls,
    reason: executed ? null : unscoredReason(run.status, ticks, toolCalls),
  };
}

function unscoredReason(status: RunStatus, ticks: number, toolCalls: number): string {
  if (status === "queued" || status === "running" || status === "judging") {
    return "This day is still going, so there is nothing to score yet.";
  }
  if (status === "aborted") {
    return "The day was stopped before it finished, so it was never scored.";
  }
  if (status === "failed") {
    return "The run errored before the day finished — the agent never ran, so there is no result.";
  }
  if (ticks === 0) return "The day never started — the agent never ran, so there is no result.";
  if (toolCalls === 0) {
    return "The agent never touched a twin — nothing was done, so there is no result.";
  }
  return "This run produced no result.";
}

/** The same question of a whole artifact. */
export function runExecuted(run: Pick<EpisodeRun, "status" | "ticks">): boolean {
  return runExecution(run).executed;
}

/**
 * Did this run leave enough behind to judge it?
 *
 * Executing and being judgeable are different questions, and conflating them
 * put a score on a run that had none. `run_msf6oyah_bfio` finished twelve ticks
 * with eighteen tool calls — executed by any reading — but its snapshots map was
 * empty, so every criterion was decided against nothing. It scored 27.8%.
 *
 * A criterion is a claim about a twin's state before and after. With no snapshot
 * for that twin there is no before and no after, so the honest answer is that we
 * cannot say — not a pass, not a fail, and not a number derived from either.
 * Callers ask this alongside `runExecution` and treat a missing twin the way
 * they treat an unexecuted run: absent, never zero.
 */
export interface RunEvidence {
  /** Twins the checklist needs that the run has no snapshot for. */
  missing: string[];
  /** True when every twin the criteria mention was captured. */
  complete: boolean;
  /** Why a twin cannot be judged, in the words a page should print. */
  reason: string | null;
}

export function runEvidence(run: {
  snapshots?: Record<string, unknown> | null;
  verdict?: { checklist?: ReadonlyArray<{ twin?: string }> } | null;
  spec?: { beats?: ReadonlyArray<{ twin?: string }> } | null;
}): RunEvidence {
  const captured = new Set(Object.keys(run.snapshots ?? {}));
  // "any" is a criterion that names no single twin — it is judged from the audit
  // log rather than a diff, so it needs no snapshot of its own.
  const needed = new Set<string>();
  for (const c of run.verdict?.checklist ?? []) {
    if (c.twin && c.twin !== "any") needed.add(c.twin);
  }
  for (const b of run.spec?.beats ?? []) {
    if (b.twin) needed.add(b.twin);
  }

  const missing = [...needed].filter((t) => !captured.has(t)).sort();
  return {
    missing,
    complete: missing.length === 0,
    reason: missing.length === 0 ? null : missingReason(missing),
  };
}

function missingReason(missing: string[]): string {
  const list = missing.join(" and ");
  return missing.length === 1
    ? `No ${list} snapshot was captured, so nothing about ${list} could be checked.`
    : `No ${list} snapshots were captured, so nothing about them could be checked.`;
}
