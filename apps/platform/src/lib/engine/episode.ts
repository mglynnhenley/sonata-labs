import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  episodeTwins,
  plannedTicks,
  tickToISO,
  type AgentTrace,
  type EpisodeRun,
  type EpisodeSpec,
  type RunStatus,
  type TickRecord,
  type TwinName,
} from "@sonata/core";
import { mirrorRunFinish } from "../../../app/api/_lib/mirror";
import { getWorld } from "../../../app/api/_lib/records";
import { newId } from "../../../app/api/_lib/store";
import { readRun, runsDir } from "../../../app/results/_lib/artifacts";
import { lastEventLine } from "../../../app/runs/_lib/story";
import { createRun, finishRun, getRun, markWorldSeeded, updateRunProgress } from "../db";
import { getSettings } from "../settings";
import type { EngineRunResult, RunEpisodeFn } from "./contract";
import { engineLoop } from "./loop";
import { ensureTwins, loadClone, twinUrlMap } from "./preflight";
import { resolveScenario, specForRun } from "./scenarios";
import { briefFor, judgeRun, scoreRun } from "./verdict";

// STARTING A DAY, AND WATCHING IT.
//
// This is the whole seam between the dashboard and the engine. A run is started
// here, held here while it plays, and written down in three places as it goes:
//
//   - platform.db, one row, updated every tick — what the runs list and the
//     Home card read, and the only record that survives this process dying;
//   - the in-memory registry below, which holds the ticks themselves — that is
//     what `status()` serves to a polling browser, so the live view never has to
//     re-read a growing file;
//   - data/runs/<runId>.json, written once at the end, in full — the artifact a
//     run is re-judged from months later with nothing live attached.
//
// The registry hangs off globalThis because Next re-evaluates route modules on
// every edit: a module-level Map would strand a running day on the first save,
// leaving a row that says "running" and a clock that never moves again.

export interface StartEpisodeInput {
  /** A saved scenario's id, or enough of its title to be unambiguous. */
  episodeId: string;
  /** OpenRouter slug of the model under test. Defaults to the Settings choice. */
  model?: string;
  /** Surfaces to attach. Defaults to the ones the scenario actually uses. */
  twins?: TwinName[];
  /** Length of the simulated day. Defaults to the scenario's own clock. */
  ticks?: number;
  /** Judge the day when it ends. On by default — a run without a diagnosis is half a result. */
  judge?: boolean;
  judgeModel?: string;
  directorModel?: string;
  /** Reset and reload the twins before tick 0. */
  seedWorld?: boolean;
  /**
   * Repeat index for a benchmark cell. Two runs of the same spec on the same
   * model differ by the provider's own sampling, which is what the seeds in a
   * matrix are measuring — so this names the repeat rather than steering it.
   */
  seed?: number;
  /** Chosen by the caller when it needs a deterministic id — see @sonata/benchmark. */
  runId?: string;
  /** The engine's loop, injected. Defaults to @sonata/engine's. */
  runEpisode?: RunEpisodeFn;
}

/** One run as every polling surface sees it. */
export interface RunView {
  runId: string;
  episodeId: string;
  title: string;
  model: string;
  status: RunStatus;
  /** Ticks recorded so far. */
  tick: number;
  plannedTicks: number;
  /** Simulated time at the head of the story. Drives the live clock. */
  simTimeISO: string;
  lastEvent: string | null;
  startedAt: number;
  endedAt: number | null;
  score: number | null;
  autonomy: number | null;
  costUsd: number;
  error: string | null;
  /** True while this process still holds the run in memory. */
  live: boolean;
}

/** Poll response. `ticks` carries only what the caller has not seen. */
export interface RunPoll {
  run: RunView;
  ticks: TickRecord[];
  /** Pass back as the next `sinceTick`. */
  nextSinceTick: number;
}

interface LiveRun {
  runId: string;
  episodeId: string;
  worldId: string;
  title: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  plannedTicks: number;
  ticks: TickRecord[];
  simTimeISO: string;
  lastEvent: string | null;
  error: string | null;
  score: number | null;
  autonomy: number | null;
  costUsd: number;
  /** Set by `cancel`, so the finish path can tell a stop from a natural end. */
  cancelled: boolean;
  controller: AbortController;
  done: Promise<EpisodeRun>;
}

const g = globalThis as unknown as { __sonataEngineRuns?: Map<string, LiveRun> };

function registry(): Map<string, LiveRun> {
  if (!g.__sonataEngineRuns) g.__sonataEngineRuns = new Map();
  return g.__sonataEngineRuns;
}

/** How long a finished run keeps its ticks in memory. After this, read the file. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [runId, entry] of registry()) {
    if (entry.endedAt !== null && now - entry.endedAt > KEEP_FINISHED_MS) registry().delete(runId);
  }
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

function toView(entry: LiveRun): RunView {
  return {
    runId: entry.runId,
    episodeId: entry.episodeId,
    title: entry.title,
    model: entry.model,
    status: entry.status,
    tick: entry.ticks.length,
    plannedTicks: entry.plannedTicks,
    simTimeISO: entry.simTimeISO,
    lastEvent: entry.lastEvent,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    score: entry.score,
    autonomy: entry.autonomy,
    costUsd: entry.costUsd,
    error: entry.error,
    live: true,
  };
}

/**
 * Begin a day.
 *
 * Returns as soon as the run exists rather than when it ends: a simulated day is
 * minutes of model calls, and the caller — a POST handler, or the CLI — needs an
 * id to follow it with. Everything after this point happens on `entry.done`.
 */
export function startEpisode(input: StartEpisodeInput): RunView {
  const episode = resolveScenario(input.episodeId);
  const spec = specForRun(episode.spec, input.ticks);
  const settings = getSettings();
  const model = input.model?.trim() || settings.models.agent;

  const wanted = input.twins?.length ? input.twins : episodeTwins(spec);
  // A twin the scenario never touches would still be reset and seeded, which
  // costs a boot and teaches nothing — so the request can only narrow the set.
  const needed = episodeTwins(spec).filter((t) => wanted.includes(t));
  const twins = needed.length > 0 ? needed : episodeTwins(spec);

  const runId = input.runId?.trim() || newId("run");
  const total = plannedTicks(spec);
  const startedAt = Date.now();

  // A benchmark cell has a deterministic id, so re-running a cell that failed
  // finds its own row already there. Reuse it rather than refusing the run.
  if (getRun(runId)) updateRunProgress(runId, { status: "queued", tick: 0 });
  else {
    createRun({
      id: runId,
      episodeId: episode.id,
      episodeTitle: episode.title,
      worldName: episode.worldName,
      model,
      totalTicks: total,
      status: "queued",
      startedAt,
    });
  }

  const base: Omit<LiveRun, "done"> = {
    runId,
    episodeId: episode.id,
    worldId: episode.worldId,
    title: episode.title,
    model,
    status: "queued",
    startedAt,
    endedAt: null,
    plannedTicks: total,
    ticks: [],
    simTimeISO: tickToISO(spec.clock, 0),
    lastEvent: null,
    error: null,
    score: null,
    autonomy: null,
    costUsd: 0,
    cancelled: false,
    controller: new AbortController(),
  };

  // The driver mutates the entry as the day plays, so the object has to exist
  // before the promise that fills it in — hence the two steps.
  const entry = base as LiveRun;
  sweep();
  registry().set(runId, entry);
  entry.done = drive(entry, spec, twins, input);
  // The driver owns every failure and records it on the entry; this only stops
  // an unhandled rejection from taking the dev server down with it.
  entry.done.catch(() => undefined);
  return toView(entry);
}

/** Start a day and wait for it. What the CLI and the benchmark runner use. */
export async function runEpisodeToCompletion(input: StartEpisodeInput): Promise<EpisodeRun> {
  const view = startEpisode(input);
  const entry = registry().get(view.runId);
  if (!entry) throw new Error(`run ${view.runId} vanished immediately after being started`);
  return entry.done;
}

// ---------------------------------------------------------------------------
// The day itself
// ---------------------------------------------------------------------------

function onTick(entry: LiveRun, record: TickRecord): void {
  entry.ticks.push(record);
  entry.simTimeISO = record.simTimeISO;
  const line = lastEventLine(record);
  if (line) entry.lastEvent = line;
  updateRunProgress(entry.runId, {
    status: "running",
    tick: entry.ticks.length,
    simTime: entry.simTimeISO,
    ...(line ? { lastEvent: line } : {}),
  });
}

/** What the artifact says when the run never got far enough to have one. */
function partialRun(entry: LiveRun, spec: EpisodeSpec, status: RunStatus): EpisodeRun {
  return {
    runId: entry.runId,
    specId: spec.id,
    specTitle: entry.title,
    model: entry.model,
    status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt ?? Date.now(),
    ticks: entry.ticks,
    snapshots: {},
    verdict: null,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

/**
 * Thrown out of `onTick` to stop a day at a tick boundary.
 *
 * The engine's loop takes no abort signal — it takes a per-tick callback, and a
 * throw from it unwinds the loop, which already keeps the ticks it has and
 * returns them. So this is the stop button: the day ends where it was, the
 * artifact is still written, and `entry.cancelled` is what tells the finish path
 * this was a stop rather than a failure.
 */
class RunStopped extends Error {
  constructor() {
    super("Stopped.");
    this.name = "RunStopped";
  }
}

/** The trace sits beside the artifact — it is the only file with verbatim
 *  provider bodies in it, so the cost breakdown can open a single call. */
function writeTrace(runId: string, trace: AgentTrace): void {
  try {
    const dir = runsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${runId}.trace.json`), `${JSON.stringify(trace)}\n`, "utf8");
  } catch (err) {
    console.warn(`[sonata] could not write the trace for ${runId}:`, message(err));
  }
}

async function drive(
  entry: LiveRun,
  spec: EpisodeSpec,
  twins: TwinName[],
  input: StartEpisodeInput,
): Promise<EpisodeRun> {
  const loop = input.runEpisode ?? engineLoop;
  const settings = getSettings();

  try {
    entry.status = "running";
    updateRunProgress(entry.runId, { status: "running" });
    await ensureTwins(twins);

    // A cloned business is loaded here, not by the engine: the engine seeds from
    // an EpisodeSpec, which carries a cast and a day but no history, so it can
    // only ever produce an empty company. When the world has a backlog it goes in
    // whole — and `injectWorld` already resets each twin as part of seeding, so
    // the loop must not then reset back over it.
    const wanted = input.seedWorld ?? true;
    const clone = wanted ? getWorld(entry.worldId)?.clone : undefined;
    if (clone) {
      entry.lastEvent = "loading the cloned business into the twins";
      updateRunProgress(entry.runId, { status: "running", lastEvent: entry.lastEvent });
      await loadClone(clone, twins);
    }

    const result = await loop({
      spec,
      runId: entry.runId,
      model: entry.model,
      directorModel: input.directorModel?.trim() || settings.models.director,
      twins,
      twinUrls: twinUrlMap(twins),
      seedWorld: clone ? false : wanted,
      onTick: (record) => {
        onTick(entry, record);
        if (entry.cancelled) throw new RunStopped();
      },
    });

    // The world in the twins is now this episode's, whatever happens next.
    if (input.seedWorld !== false) markWorldSeeded(entry.worldId);
    // A loop that reported its own ticks is the record; one that reported none
    // still hands them all back at the end, and the registry has to have them
    // or the replay opens on an empty day.
    if (entry.ticks.length === 0 && result.run.ticks.length > 0) entry.ticks = result.run.ticks;
    writeTrace(entry.runId, result.trace);

    return await complete(entry, result, spec, input);
  } catch (err) {
    return fail(entry, spec, err);
  }
}

async function complete(
  entry: LiveRun,
  result: EngineRunResult,
  spec: EpisodeSpec,
  input: StartEpisodeInput,
): Promise<EpisodeRun> {
  const run = result.run;
  const status: RunStatus = entry.cancelled ? "aborted" : run.status === "failed" ? "failed" : "done";
  const { checklist, verdict } = scoreRun(run, spec, { audit: result.audit, cost: result.cost });
  const scored: EpisodeRun = {
    ...run,
    status,
    endedAt: run.endedAt ?? Date.now(),
    ticks: run.ticks.length > 0 ? run.ticks : entry.ticks,
    verdict,
    // A stopped day is not a broken one, and the engine's own note for it is the
    // sentinel above — which would read as a crash on the results page.
    ...(entry.cancelled ? { error: undefined } : {}),
  };

  entry.score = verdict.score;
  entry.autonomy = verdict.autonomy;
  entry.costUsd = verdict.cost.usd;

  // One terminal write for the row and the artifact together, through the same
  // function the rest of the dashboard finishes runs with.
  mirrorRunFinish({ run: scored, spec, checklist });

  const wantsJudge = input.judge !== false && scored.ticks.length > 0 && !entry.cancelled;
  if (wantsJudge) {
    entry.status = "judging";
    updateRunProgress(entry.runId, { status: "judging" });
    try {
      const judged = await judgeRun(scored, briefFor(spec), {
        ...(input.judgeModel?.trim() ? { model: input.judgeModel.trim() } : {}),
        signal: entry.controller.signal,
      });
      entry.autonomy = judged.autonomy;
      scored.verdict = { ...verdict, autonomy: judged.autonomy, judge: judged.report };
    } catch (err) {
      // A judge that fails costs the run its diagnosis, not its score. The
      // checklist already ran, the artifact is already on disk, and the note
      // says what to retry with `sonata judge <runId>`.
      entry.error = `The day finished, but the judge did not: ${message(err)}`;
      finishRun({
        id: entry.runId,
        status,
        outcome: verdict.outcome,
        score: verdict.score,
        autonomy: verdict.autonomy,
        costUsd: verdict.cost.usd,
        error: entry.error,
        endedAt: scored.endedAt ?? Date.now(),
      });
    }
  }

  entry.status = status;
  entry.endedAt = scored.endedAt ?? Date.now();
  return scored;
}

function fail(entry: LiveRun, spec: EpisodeSpec, err: unknown): EpisodeRun {
  const status: RunStatus = entry.cancelled ? "aborted" : "failed";
  entry.status = status;
  entry.error = message(err);
  entry.endedAt = Date.now();

  // Even a day that fell over at 09:15 is worth writing down: the ticks it did
  // record are usually the reason it fell over.
  const run = partialRun(entry, spec, status);
  const { checklist, verdict } = scoreRun(run, spec);
  entry.score = verdict.score;
  entry.autonomy = verdict.autonomy;
  mirrorRunFinish({ run: { ...run, verdict }, spec, checklist });
  finishRun({
    id: entry.runId,
    status,
    outcome: verdict.outcome,
    score: verdict.score,
    autonomy: verdict.autonomy,
    error: entry.error,
    endedAt: entry.endedAt,
  });
  return run;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Watching and stopping
// ---------------------------------------------------------------------------

function fromRow(runId: string): RunView | null {
  const row = getRun(runId);
  if (!row) return null;
  return {
    runId: row.id,
    episodeId: row.episodeId,
    title: row.episodeTitle,
    model: row.model,
    status: row.status,
    tick: row.tick,
    plannedTicks: row.totalTicks,
    simTimeISO: row.simTime ?? "",
    lastEvent: row.lastEvent,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    score: row.score,
    autonomy: row.autonomy,
    costUsd: row.costUsd,
    error: row.error,
    live: false,
  };
}

/**
 * Where a run has got to, and the ticks the caller has not seen.
 *
 * Served from memory while this process owns the run and from the saved artifact
 * afterwards, so the same call works during a run, after it, and after a restart.
 */
export function status(runId: string, sinceTick = 0): RunPoll | null {
  const from = Math.max(0, Math.floor(sinceTick));
  const entry = registry().get(runId);
  if (entry) {
    return {
      run: toView(entry),
      ticks: entry.ticks.filter((t) => t.tick >= from),
      nextSinceTick: entry.ticks.length,
    };
  }

  const run = fromRow(runId);
  if (!run) return null;
  const saved = readRun(runId);
  const ticks = saved?.ticks ?? [];
  return {
    run: saved?.verdict ? { ...run, score: saved.verdict.score, autonomy: saved.verdict.autonomy } : run,
    ticks: ticks.filter((t) => t.tick >= from),
    nextSinceTick: ticks.length,
  };
}

/**
 * The promise a started run settles on, for a caller that wants to wait without
 * polling. Null once the registry has let the run go.
 */
export function whenDone(runId: string): Promise<EpisodeRun> | null {
  return registry().get(runId)?.done ?? null;
}

/** Every run this process is still driving, newest first. */
export function liveRuns(): RunView[] {
  return [...registry().values()]
    .filter((e) => e.endedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toView);
}

/**
 * Stop a day early. The signal reaches the engine mid-tick, so the run ends at
 * the tick boundary and still writes its artifact — a day stopped at 11:00
 * scored whatever it had scored by 11:00.
 */
export function cancel(runId: string): RunView | null {
  const entry = registry().get(runId);
  if (!entry) {
    const row = getRun(runId);
    if (!row) return null;
    if (row.status === "queued" || row.status === "running" || row.status === "judging") {
      // Started by a process that is now gone: nothing is advancing it, so the
      // honest thing is to stop calling it running.
      finishRun({ id: runId, status: "aborted", error: "Stopped.", endedAt: Date.now() });
    }
    return fromRow(runId);
  }

  entry.cancelled = true;
  entry.controller.abort();
  return toView(entry);
}
