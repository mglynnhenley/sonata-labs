import type { Clock } from "./types/episode";
import type { CriterionStatus, EpisodeRun, RunStatus, TickRecord } from "./types/run";
import type { TwinName } from "./types/world";

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

// ---------------------------------------------------------------------------
// A DAY THAT DID NOT FINISH.
//
// A scenario declares a clock — 32 ticks — and its criteria and its brief are
// written for all of it. A run may execute fewer: `run_msg6yuxd_6tsw` executed
// twelve. Three beats were scheduled after tick 11 and none of them fired, so the
// customer whose message arrives at t20 never wrote to the agent at all, and the
// brief's "handle the three open disputes" named a dispute that was never opened.
// The run was then graded against the whole checklist and the judge returned a
// critical for ignoring that customer — noting, in the same breath, that there was
// "no scripted arrival shown". It had the evidence and no permission to use it.
//
// Grading a twelve-tick run against a thirty-two-tick scenario measures the
// interruption, not the agent. So the interruption is read off the artifact, here,
// before anything is scored.
// ---------------------------------------------------------------------------

/**
 * A criterion that is OUR defect rather than the agent's.
 *
 * "We could not check this" and "we never gave the agent the chance" are different
 * sentences, and only one of them is about the agent. Both leave the score — that
 * much `notApplicable` already did — but only the second is something a published
 * benchmark has to own in its own voice, and a reader who cannot tell them apart
 * concludes their model is bad on evidence that is ours.
 *
 * Carried as a mark on the evidence rather than a fourth `CriterionStatus`, because
 * a `CriterionResult` is the PERSISTED row and it does not carry the criterion's
 * beat `ref`: every page, mirror and re-judge re-reads the saved row, and a
 * classification that cannot be recomputed from that row has to survive inside it.
 */
export const HARNESS_DEFECT_MARK = "[harness defect]";

export function harnessDefectEvidence(why: string): string {
  return `${HARNESS_DEFECT_MARK} ${why}`;
}

export function isHarnessDefect(c: { status: CriterionStatus; evidence?: string }): boolean {
  return c.status === "notApplicable" && (c.evidence ?? "").startsWith(HARNESS_DEFECT_MARK);
}

/** Why nothing from a scripted beat ever reached the agent. */
export type UnfiredWhy =
  /** The run stopped before this beat's tick came round. */
  | "cut-short"
  /** Its tick ran and the engine fired nothing — a scheduling bug, not a short day. */
  | "skipped"
  /** The engine tried and the twin refused it, so nothing landed. */
  | "inject-failed";

export interface UnfiredBeat {
  id: string;
  /** `BeatMeta.ref` — what a criterion points at, and how one is matched to this. */
  ref?: string;
  /** The tick it was scheduled for. */
  tick: number;
  twin: TwinName;
  kind: string;
  why: UnfiredWhy;
  /** One line naming what the agent was never shown. */
  summary: string;
  /** The prose it carried — the facts it would have handed over. */
  text: string;
}

/** Minimum of a `Beat` this reads. Written structurally so a `Beat[]` fits as-is. */
interface BeatLike {
  id: string;
  tick: number;
  ref?: string;
  twin: TwinName;
  kind: string;
  payload?: unknown;
}

export interface RunTruncation {
  /** True when the day the spec declared is longer than the day that ran. */
  truncated: boolean;
  executedTicks: number;
  /** Ticks the scenario's clock declared, capped by `termination.maxTicks`. */
  scheduledTicks: number;
  /** Beats the agent was never shown, in tick order. */
  unfired: UnfiredBeat[];
  /** Their refs, for matching a criterion's `ref` without walking the list. */
  unfiredRefs: string[];
  /**
   * Everything the beats that DID fire put in front of the agent, concatenated.
   *
   * Here because a criterion's subject is not always a beat ref. "An email to Arun
   * mentions the approved refund amount" names a PHRASE, and on the run that opened
   * this pass that phrase — $5,000 — was only ever spoken by the beat at t12, which
   * never fired. Failing the agent for not saying a number nobody told it is the
   * same defect wearing different clothes, and it is only visible by asking whether
   * the day the agent actually saw contained the phrase at all. See `withheld`.
   */
  shownText: string;
  /** What a verdict prints. Null when the whole day ran and every beat fired. */
  notice: string | null;
}

/** Every string VALUE inside a beat payload — keys excluded, so "body" is not text. */
function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectText(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectText(v, out);
}

function beatText(payload: unknown): string {
  const out: string[] = [];
  collectText(payload, out);
  return out.join(" \n");
}

function beatLine(b: BeatLike, why: UnfiredWhy): string {
  const text = beatText(b.payload).replace(/\s+/g, " ").trim();
  const excerpt = text.length > 160 ? `${text.slice(0, 159)}…` : text;
  const when = why === "inject-failed" ? `t${b.tick} (the twin refused it)` : `t${b.tick}`;
  return `${when} ${b.twin} ${b.kind}${b.ref ? ` "${b.ref}"` : ""} — ${excerpt || "(no text)"}`;
}

/**
 * Which of the day's ticks ran, and which of its beats never reached the agent.
 *
 * The tick count is the headline and the beats are the precise version of it: a run
 * can execute every tick and still have dropped a beat the twin refused, and a beat
 * that never fired cannot be the subject of a fair criterion whatever the reason.
 *
 * Deliberately silent about WHOSE fault the short day was. A day cut off by the
 * engine's idle guard is the agent's own stalling, and that stall is a finding in
 * its own right — but it is still true that the customer at t20 never wrote, and the
 * agent may not be marked down for ignoring a message it was never sent. What
 * reached the agent and who is to blame are separate questions, and only the first
 * one belongs in a checklist.
 */
export function runTruncation(
  run: { ticks: TickRecord[] },
  spec: {
    clock: Pick<Clock, "ticks">;
    beats: ReadonlyArray<BeatLike>;
    termination?: { maxTicks?: number } | null;
  },
): RunTruncation {
  // Tick indices are authoritative over the array length: a record dropped mid-run
  // would otherwise report a shorter day than the one that actually played.
  const executedTicks = run.ticks.reduce((n, t) => Math.max(n, t.tick + 1), 0);
  const cap = spec.termination?.maxTicks;
  const scheduledTicks =
    typeof cap === "number" && cap > 0 ? Math.min(cap, spec.clock.ticks) : spec.clock.ticks;

  const landed = new Set<string>();
  const failed = new Set<string>();
  for (const t of run.ticks) {
    for (const b of t.beatsFired) {
      if (b.handle && !b.error) landed.add(b.beatId);
      else failed.add(b.beatId);
    }
  }

  const unfired: UnfiredBeat[] = [];
  const shown: string[] = [];
  for (const b of spec.beats) {
    if (landed.has(b.id)) {
      shown.push(beatText(b.payload));
      continue;
    }
    const why: UnfiredWhy = failed.has(b.id)
      ? "inject-failed"
      : b.tick >= executedTicks
        ? "cut-short"
        : "skipped";
    unfired.push({
      id: b.id,
      ...(b.ref === undefined ? {} : { ref: b.ref }),
      tick: b.tick,
      twin: b.twin,
      kind: b.kind,
      why,
      summary: beatLine(b, why),
      text: beatText(b.payload),
    });
  }
  unfired.sort((a, b) => a.tick - b.tick);

  // The world also improvises. Anything the director actually injected reached the
  // agent as surely as a scripted beat did, so it counts as shown.
  for (const t of run.ticks) {
    for (const e of t.directorEvents) if (!e.error) shown.push(beatText(e.payload));
  }

  const truncated = executedTicks < scheduledTicks;
  return {
    truncated,
    executedTicks,
    scheduledTicks,
    unfired,
    unfiredRefs: unfired.map((b) => b.ref).filter((r): r is string => Boolean(r)),
    shownText: shown.join(" \n"),
    notice: truncationNotice(truncated, executedTicks, scheduledTicks, unfired),
  };
}

function truncationNotice(
  truncated: boolean,
  executedTicks: number,
  scheduledTicks: number,
  unfired: UnfiredBeat[],
): string | null {
  if (!truncated && unfired.length === 0) return null;

  const head = truncated
    ? `THIS DAY DID NOT FINISH: ${executedTicks} of the ${scheduledTicks} ticks this scenario ` +
      `declares actually ran, so the agent was given ${Math.round((executedTicks / Math.max(scheduledTicks, 1)) * 100)}% of the day its brief and its criteria were written for.`
    : `Every tick of this day ran, but ${unfired.length} scripted moment(s) never reached the agent.`;

  if (unfired.length === 0) {
    return `${head} No scripted beat was lost, but anything the brief expected from tick ${executedTicks} onwards had no chance to happen.`;
  }

  return (
    `${head} ${unfired.length} scripted moment(s) never reached it:\n` +
    unfired.map((b) => `  - ${b.summary}`).join("\n") +
    `\nNothing that depended on those moments may be counted against the agent: it was never shown them.`
  );
}

/**
 * The unfired beat that is the only place a phrase was ever spoken, or null.
 *
 * Null when the day the agent saw contained the phrase too — then it had the fact
 * and the criterion is fair. Null also when nothing in the day carried it at all,
 * because that is a phrase the agent was expected to originate, and originating it
 * is exactly what the criterion is testing.
 */
export function withheld(t: RunTruncation, phrase: string): UnfiredBeat | null {
  const needle = phrase.trim().toLowerCase();
  // Two characters is a coin toss against a day of prose; a phrase this short is
  // not evidence that anything was withheld.
  if (needle.length < 3) return null;
  if (t.shownText.toLowerCase().includes(needle)) return null;
  return t.unfired.find((b) => b.text.toLowerCase().includes(needle)) ?? null;
}
