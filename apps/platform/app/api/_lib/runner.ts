import type { CriterionResult, RunStatus, VerdictOutcome } from "@sonata/core";
import { runExecution } from "@sonata/core";
import {
  cancel,
  reconcileRuns,
  startEpisode,
  status as engineStatus,
  type RunPoll as EnginePoll,
} from "@/lib/engine/episode";
import { listLiveRuns } from "@/lib/db";
import { liveSessionFor, sessionTwinLinks } from "@/lib/engine/session";
import { readRun } from "../../results/_lib/artifacts";
import { getEpisode } from "./records";
import { getDoc, listDocs, putDoc } from "./store";
import type { RunDetail, RunSummary, StartRunInput } from "./types";

// Dashboard projection of the shared Inspect launcher. The document store is
// an index for list/live views; the session and saved artifact hold the evidence.
// Agent calls live in Inspect, while Sonata owns the clock, colleagues and judge.
// Pause is unsupported. Stop finalizes the workplace and cancels the worker.
// Cost remains unknown until the captured agent/world/judge traces are joined.

/** The run as this dashboard stores it. No bookkeeping of its own any more. */
export type RunDoc = RunDetail;

/** Statuses a run never moves off. Anything else is still being produced. */
const TERMINAL: readonly RunStatus[] = ["done", "failed", "aborted"];

function isLive(status: RunStatus): boolean {
  return !TERMINAL.includes(status);
}

// ---------------------------------------------------------------------------
// Reading a run. The stored doc is an index; the engine is the record.
// ---------------------------------------------------------------------------

export function toSummary(doc: RunDoc): RunSummary {
  const { ticks: _ticks, story: _s, task: _k, clock: _cl, ...summary } = doc;
  return { ...summary, twinLinks: sessionTwinLinks(doc.runId) };
}

/**
 * The whole run. An identity now that `RunDoc` carries no bookkeeping of its
 * own — kept because every caller reads a detail through this seam, and the day
 * the two shapes diverge again there is one place to put the difference.
 */
export function toDetail(doc: RunDoc): RunDetail {
  return { ...doc, twinLinks: sessionTwinLinks(doc.runId) };
}

function project(stored: RunDoc, poll: EnginePoll): RunDoc {
  const view = poll.run;
  const endedAt = view.endedAt;
  const { error: _stale, ...rest } = stored;
  return {
    ...rest,
    status: view.status,
    startedAt: view.startedAt,
    endedAt,
    durationMs: (endedAt ?? Date.now()) - view.startedAt,
    tickCount: view.tick,
    plannedTicks: view.plannedTicks,
    twins: view.twins,
    simTimeISO: view.simTimeISO || stored.simTimeISO,
    score: view.score,
    autonomy: view.autonomy,
    cost: view.cost,
    ticks: poll.ticks,
    ...(view.error ? { error: view.error } : {}),
  };
}

/**
 * The stored doc, brought up to date from the engine.
 *
 * A finished day never changes, so it is served straight from the index; only a
 * run that is still being produced costs a read. The write is skipped unless the
 * day actually moved — a poll every second must not rewrite a megabyte of ticks
 * to say the wall clock advanced.
 */
function refresh(stored: RunDoc): RunDoc {
  if (!isLive(stored.status)) {
    const execution = runExecution(stored);
    return execution.executed ? stored : {
      ...stored, score: null, autonomy: null,
      ...(execution.reason ? { error: stored.error ?? execution.reason } : {}),
    };
  }

  // `engineStatus` reconciles as it reads: a run whose OWNER has gone away comes
  // back terminal, with the tick it reached and the last thing it said.
  //
  // What this must never do is retire a run because this process is not the one
  // driving it. `poll.run.live` means only "in this process's registry", and the
  // CLI drives runs of its own from another process entirely — reading that flag
  // as death is how a day being played in a terminal would be declared over by
  // somebody idly opening the runs list. Ownership is recorded on the row; the
  // engine reads it there.
  const poll = engineStatus(stored.runId);
  if (!poll) return orphaned(stored);

  const doc = project(stored, poll);
  if (
    doc.status !== stored.status ||
    doc.tickCount !== stored.tickCount ||
    doc.endedAt !== stored.endedAt
  ) {
    putDoc("run", doc.runId, doc);
  }
  return doc;
}

/** Indexed here, unknown to the engine: the row it was following is gone. */
function orphaned(stored: RunDoc): RunDoc {
  const endedAt = Date.now();
  const doc: RunDoc = {
    ...stored,
    status: "aborted",
    endedAt,
    durationMs: endedAt - stored.startedAt,
    error: "The engine has no record of this run, so it cannot still be playing.",
  };
  putDoc("run", doc.runId, doc);
  return doc;
}

export function getRun(runId: string): RunDoc | undefined {
  const stored = getDoc<RunDoc>("run", runId);
  return stored ? refresh(stored) : undefined;
}

export function listRuns(): RunSummary[] {
  return listDocs<RunDoc>("run").map((doc) => toSummary(refresh(doc)));
}

/** The run the dashboard should be showing: the newest one still moving. */
export function activeRun(): RunDoc | undefined {
  for (const stored of listDocs<RunDoc>("run")) {
    if (!isLive(stored.status)) continue;
    const doc = refresh(stored);
    if (isLive(doc.status)) return doc;
  }
  return undefined;
}

/** A day still being played against a scenario, and which kind of day it is. */
export interface LiveWork {
  kind: "run" | "session";
  id: string;
}

/**
 * Whatever is mid-flight against this scenario right now, or undefined.
 *
 * Exists so an edit to a scenario's rubric can refuse while a day is being
 * graded against it — a run embeds the spec it plays, but a session reads it
 * back at scoring time, and either way a benchmark whose criteria moved
 * halfway through is not a benchmark.
 *
 * Reads the ROWS, not this dashboard's run documents: `sonata run` and the
 * benchmark runner drive days this index has never heard of, and their rubric
 * is just as much in play. Both reads reconcile as they go, so a day whose
 * driver died does not keep its scenario locked until someone opens Home.
 */
export function liveWorkFor(episodeId: string): LiveWork | undefined {
  const run = listLiveRuns().find((r) => r.episodeId === episodeId);
  if (run) return { kind: "run", id: run.id };

  const session = liveSessionFor(episodeId);
  return session ? { kind: "session", id: session.sessionId } : undefined;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * Begin a day, for real.
 *
 * Returns as soon as the engine has an id: a simulated day is minutes of model
 * calls against the clones, and the POST that started it must not hold the
 * browser open for them. Everything after this point is followed by polling.
 */
export function startRun(input: StartRunInput): RunDoc {
  const view = startEpisode({
    ...input,
    episodeId: input.episodeId,
    model: input.model,
    ticks: input.ticks,
    // Empty means "whatever the scenario uses" — the engine's own default, and
    // the request can only ever narrow it.
    ...(input.twins.length > 0 ? { twins: input.twins } : {}),
  });

  // Resolved by the engine, which registers a shipped scenario the first time it
  // is asked for — so this is read after starting, by the id the engine settled
  // on, not the one the caller typed.
  const episode = getEpisode(view.episodeId);
  if (!episode) {
    cancel(view.runId);
    throw new Error(`The scenario ${view.episodeId} could not be read back after the run started.`);
  }

  const doc: RunDoc = {
    runId: view.runId,
    specId: view.episodeId,
    specTitle: view.title,
    model: view.model,
    status: view.status,
    startedAt: view.startedAt,
    endedAt: null,
    durationMs: 0,
    tickCount: 0,
    plannedTicks: view.plannedTicks,
    twins: view.twins,
    simTimeISO: view.simTimeISO,
    // The engine has no pause to report. See the header.
    paused: false,
    score: null,
    autonomy: null,
    cost: null,
    story: episode.story,
    task: episode.task,
    clock: { ...episode.spec.clock, ticks: view.plannedTicks },
    ticks: [],
  };
  putDoc("run", doc.runId, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

/**
 * Not supported, and not silently ignored either.
 *
 * The engine's tick callback is synchronous, so there is no point in the day at
 * which it can be held open — pausing would mean suspending a provider call
 * mid-flight, and a "paused" run that kept spending would be worse than no pause
 * at all. The honest control for a day you want to stop is Stop.
 */
export function pauseRun(_runId: string): RunDoc | undefined {
  throw new Error(
    "A run cannot be paused: the day is a chain of live model calls, with nothing to freeze between them. Stop the day instead.",
  );
}

export function resumeRun(_runId: string): RunDoc | undefined {
  throw new Error("A run cannot be paused, so there is nothing to resume.");
}

/**
 * Stop a day early.
 *
 * The stop reaches the engine, which ends the run at the next tick boundary: the
 * call already in flight finishes, and no further model call is made. So the
 * returned doc may still say "running" — the day is over as soon as the tick it
 * was in completes, and the next poll says so.
 */
export function abortRun(runId: string): RunDoc | undefined {
  const stored = getDoc<RunDoc>("run", runId);
  if (!stored) return undefined;
  cancel(runId);
  return refresh(stored);
}

/**
 * Bring the index back into line with the engine.
 *
 * Named for what it used to do — re-arm the timers of the stand-in tick loop
 * across a dev-server reload. There are no timers now, and a real day cannot be
 * resumed: this retires whatever nothing is driving any more, so the list never
 * shows a day that is not happening.
 *
 * Two passes, because there are two kinds of stale record. `reconcileRuns` works
 * on the rows — including runs started from the CLI, which this dashboard has no
 * document for and would otherwise never look at, which is exactly how one sat
 * on Home reading "Running · Tick 2 of 4" for twenty-three hours. `refresh` then
 * brings the documents this dashboard does own into line with them.
 */
export function resumeInterruptedRuns(): void {
  reconcileRuns();
  for (const doc of listDocs<RunDoc>("run")) refresh(doc);
}

// ---------------------------------------------------------------------------
// Reading a finished run back
// ---------------------------------------------------------------------------

/**
 * The finished run's verdict, from the artifact the engine filed for it. Null
 * outcome and an empty checklist for a run that never got one — a day that
 * crashed or was stopped early has no verdict, and inventing one from the ticks
 * it did record is what this whole rewrite is undoing.
 */
export function verdictFor(doc: RunDoc): {
  outcome: VerdictOutcome | null;
  checklist: CriterionResult[];
} {
  const verdict = readRun(doc.runId)?.verdict;
  return verdict
    ? { outcome: verdict.outcome, checklist: verdict.checklist }
    : { outcome: null, checklist: [] };
}
