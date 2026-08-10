import type { CriterionResult, RunStatus, VerdictOutcome } from "@sonata/core";
import { cancel, startEpisode, status as engineStatus, type RunPoll as EnginePoll } from "@/lib/engine/episode";
import { readRun } from "../../results/_lib/artifacts";
import { getEpisode } from "./records";
import { getDoc, listDocs, putDoc } from "./store";
import type { RunDetail, RunSummary, StartRunInput } from "./types";

// THE DASHBOARD'S VIEW OF A RUN.
//
// An adapter, and nothing else. Starting a day, playing it, stopping it and
// scoring it all live in src/lib/engine/episode.ts — the same path `sonata run`
// takes — so a day started from the Start button and a day started from the
// terminal are the same day, driven by the same code, costing the same money.
// What used to be here was a scripted stand-in with a seeded coin flip where the
// agent should have been; it is gone, and there is no flag that brings it back.
//
// This file translates. The engine speaks `RunView`; the dashboard's routes and
// components speak `RunDoc`/`RunSummary`/`RunDetail`, which are unchanged. The
// document store is kept as an INDEX of the runs this dashboard started — it is
// what the runs list and the scenario cards read — and it is refreshed from the
// engine on read, never written ahead of it.
//
// Two things the engine cannot do, said out loud rather than faked:
//   - PAUSE. A day is a chain of live model calls; the engine's tick callback is
//     synchronous, so there is no seam to hold one open at. `pauseRun` says so.
//   - LIVE SPEND. Cost is summed from the run's trace when the day ends, so
//     `cost` is null while it plays rather than a running $0.00.

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
  return summary;
}

/**
 * The whole run. An identity now that `RunDoc` carries no bookkeeping of its
 * own — kept because every caller reads a detail through this seam, and the day
 * the two shapes diverge again there is one place to put the difference.
 */
export function toDetail(doc: RunDoc): RunDetail {
  return doc;
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
  if (!isLive(stored.status)) return stored;

  let poll = engineStatus(stored.runId);
  // Nothing in this process is driving it. A day cannot be picked up where it
  // left off — the agent's conversation, its trace and the twins' cursors all
  // died with the process that held them — so it is stopped through the engine's
  // own path rather than left claiming to be running with a frozen clock.
  if (poll && !poll.run.live && isLive(poll.run.status)) {
    cancel(stored.runId);
    poll = engineStatus(stored.runId);
  }
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
 * resumed: `refresh` stops any run this process is no longer driving, so the
 * list never shows a day that is not happening.
 */
export function resumeInterruptedRuns(): void {
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
