import {
  agentToolCalls,
  type EpisodeRun,
  type RunStatus,
  type TickRecord,
  type TwinAuditRow,
} from "@sonata/core";

// ---------------------------------------------------------------------------
// DAYS NOBODY EVER PLAYED.
//
// For most of this product's life the dashboard's Start button did not run an
// agent. `advanceTick` in app/api/_lib/runner.ts played the scripted beats on a
// timer and then decided, from a seeded RNG, whether "the agent" had acted:
//
//     const random = rng(seedFrom(`${runId}:${model}:${tick}`));
//     if (random() > 0.28) { /* it acted */ }
//
// The model name was a hash seed. The reasoning was a template literal, the
// colleague's reply was one hard-coded sentence, and no model was ever called.
// Those runs were then scored, filed beside real ones, and averaged into Home's
// headline autonomy and into the Compare table — which was comparing models that
// were never asked anything.
//
// This module answers one question off the artifact: was this day fabricated?
// It is not a date cutoff and not a filename convention. Both would be guesses,
// and a guess is what put the numbers there in the first place.
//
// THE TEST, and why a cheap real run cannot trip it.
//
// A twin handle is the id the CLONE issued — the Gmail message id, the Slack
// `ts`, the calendar event id it minted when something was injected into it. The
// stand-in had no clone to ask, so it wrote its own: `sim-<beatId>`. Nothing that
// ever spoke to a twin can produce that string; it is the stand-in's signature,
// present on every beat it fired and every reply it invented, and it survives
// everything downstream — re-judging, reconciling, verdict-stripping — because it
// is written into the tick records themselves.
//
// A cheap real run is still a real run: a $0.004 haiku day, a plugged-in agent
// whose tokens we never see, a day that ended after two ticks. Every one of them
// carries handles the clones issued, or audit rows, or a captured snapshot. So
// "cheap" is not the test and was never allowed to be — `sess_msfvd39z_fro4` in
// this repo cost nothing, called no model we metered and made exactly one tool
// call, and it is a real session with eight real handles on it.
//
// The second clause below is the backstop for a stand-in day so quiet it fired no
// beat at all, and it asks for FOUR absences at once: the run claims tool calls,
// yet no handle came from a clone, no audit row was written, no snapshot was
// taken and no model was called. A run with all four has nothing in it that came
// from anywhere real — there is no evidence left to misclassify.
// ---------------------------------------------------------------------------

/** The id the stand-in wrote where a clone's own id belongs. */
export const SIMULATED_HANDLE_PREFIX = "sim-";

/** What such a run wears wherever a verdict would have gone. */
export const SIMULATED_LABEL = "Simulated";

/** Why it has no score, in the words a page should print. */
export const SIMULATED_REASON =
  "No agent ever ran this day. It was played by the dashboard's stand-in loop: the beats fired " +
  "on a timer, the reasoning was a template, the colleagues' replies were one fixed sentence, " +
  "and whether it acted was a coin flip seeded off the model's name. Nothing here is a " +
  "measurement of a model.";

/** The shorter form, for a hint or a footnote. */
export const SIMULATED_HINT =
  "Played by the old stand-in loop — no model was called, so there is nothing to measure.";

export interface RunSimulation {
  /** True when this artifact was written by the stand-in rather than the engine. */
  simulated: boolean;
  /** Twin handles the stand-in invented — `sim-…` ids no clone ever issued. */
  fabricatedHandles: number;
  /** Handles a clone did issue. One of these is enough to prove a run was real. */
  clonedHandles: number;
  /** `SIMULATED_REASON` when simulated, null when not. */
  reason: string | null;
}

/**
 * Everything the question is decided from. All optional but `status` and `ticks`,
 * because the artifact loses its verdict on the way to some callers — see below.
 */
export interface SimulationInput {
  status: RunStatus;
  ticks: TickRecord[];
  audit?: readonly TwinAuditRow[];
  snapshots?: EpisodeRun["snapshots"] | null;
  verdict?: { cost?: { llmCalls?: number } | null } | null;
}

function countHandles(ticks: TickRecord[]): { fabricated: number; cloned: number } {
  let fabricated = 0;
  let cloned = 0;
  for (const tick of ticks) {
    for (const beat of tick.beatsFired) {
      if (!beat.handle) continue;
      if (beat.handle.id.startsWith(SIMULATED_HANDLE_PREFIX)) fabricated += 1;
      else cloned += 1;
    }
    for (const event of tick.directorEvents) {
      if (!event.handle) continue;
      if (event.handle.id.startsWith(SIMULATED_HANDLE_PREFIX)) fabricated += 1;
      else cloned += 1;
    }
  }
  return { fabricated, cloned };
}

/**
 * Was this day fabricated?
 *
 * Deliberately stable under verdict-stripping. `normalizeRun` refuses to hand a
 * simulated run's verdict back, so a later caller asking this same question sees
 * `llmCalls` as absent — which only ever makes the backstop clause more eager.
 * That is safe because the backstop also demands zero clone handles, zero audit
 * rows and zero snapshots, and a real run that lost its verdict still has those.
 * The primary clause reads the tick records, which nothing downstream rewrites.
 */
export function runSimulation(run: SimulationInput): RunSimulation {
  const { fabricated, cloned } = countHandles(run.ticks);
  const llmCalls = run.verdict?.cost?.llmCalls ?? 0;
  const auditRows = run.audit?.length ?? 0;
  const snapshots = Object.keys(run.snapshots ?? {}).length;

  const nothingReal =
    agentToolCalls(run.ticks) > 0 &&
    cloned === 0 &&
    auditRows === 0 &&
    snapshots === 0 &&
    llmCalls === 0;

  // A live run is not judged: the stand-in is gone, so nothing writing ticks now
  // can be one, and a run still being appended to has not finished proving itself.
  const settled = run.status === "done" || run.status === "failed" || run.status === "aborted";
  const simulated = settled && (fabricated > 0 || nothingReal);

  return {
    simulated,
    fabricatedHandles: fabricated,
    clonedHandles: cloned,
    reason: simulated ? SIMULATED_REASON : null,
  };
}

export function isSimulated(run: SimulationInput): boolean {
  return runSimulation(run).simulated;
}
