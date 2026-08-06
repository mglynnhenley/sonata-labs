import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  episodeTwins,
  plannedTicks,
  tickToISO,
  type AgentTrace,
  type ByTwin,
  type EpisodeRun,
  type EpisodeSpec,
  type RunCost,
  type RunStatus,
  type Termination,
  type TickRecord,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinName,
  type TwinSnapshot,
} from "@sonata/core";
import { createAdapters } from "@sonata/engine";
import { mirrorRunFinish } from "../../../app/api/_lib/mirror";
import { getEpisode as getScenario, getWorld } from "../../../app/api/_lib/records";
import { newId } from "../../../app/api/_lib/store";
import { readRun, runsDir } from "../../../app/results/_lib/artifacts";
import { lastEventLine } from "../../../app/runs/_lib/story";
import { createRun, finishRun, getRun, markWorldSeeded, updateRunProgress } from "../db";
import { getSettings } from "../settings";
import type { EngineRunResult, RunEpisodeFn } from "./contract";
import { engineLoop } from "./loop";
import { applyStoredApiKey } from "./apiKey";
import { ensureTwins, loadClone, twinUrlMap } from "./preflight";
import { resolveScenario, specForRun } from "./scenarios";
import { judgeRun, scoreRun } from "./verdict";

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
  /**
   * Raise (or lower) this run's stop guards, leaving the saved scenario alone.
   *
   * Exists because a guard sized for a shorter day silently truncates a longer
   * one, and a truncated day cannot be graded against a whole checklist without
   * charging our interruption to the agent. When the answer a run has to give is
   * "what does this model do across the WHOLE day", the budget has to be allowed
   * to say so out loud — and it is merged into the spec the artifact is filed
   * with, so a reader months later sees the guards that were actually in force
   * rather than the ones the scenario was saved with.
   */
  termination?: Partial<Termination>;
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
  /**
   * The surfaces this run attached — narrowed from the scenario's by the caller,
   * so it is the run's own answer rather than the scenario's.
   */
  twins: TwinName[];
  /** Simulated time at the head of the story. Drives the live clock. */
  simTimeISO: string;
  lastEvent: string | null;
  startedAt: number;
  endedAt: number | null;
  score: number | null;
  autonomy: number | null;
  /**
   * What the day cost, in full.
   *
   * Summed from the run's own trace when the loop returns, so it is null while
   * the day plays rather than a running $0.00 that reads as "free". A day that
   * was stopped or that crashed still has one — it was paid either way — and it
   * is the only place that figure survives for a run with no verdict.
   */
  cost: RunCost | null;
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
  twins: TwinName[];
  ticks: TickRecord[];
  simTimeISO: string;
  lastEvent: string | null;
  error: string | null;
  score: number | null;
  autonomy: number | null;
  cost: RunCost | null;
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
    twins: entry.twins,
    simTimeISO: entry.simTimeISO,
    lastEvent: entry.lastEvent,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    score: entry.score,
    autonomy: entry.autonomy,
    cost: entry.cost,
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
  const spec = specForRun(episode.spec, input.ticks, input.termination);
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
    twins,
    ticks: [],
    simTimeISO: tickToISO(spec.clock, 0),
    lastEvent: null,
    error: null,
    score: null,
    autonomy: null,
    cost: null,
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

// ---------------------------------------------------------------------------
// Evidence. The artifact's own half of the promise.
// ---------------------------------------------------------------------------

// The engine captures both snapshots and the audit window itself — but it does
// so at the END of its try block, so a loop that unwinds takes the capture with
// it. `cancel` unwinds the loop by design (see `RunStopped`), which means a day
// stopped at 11:00 was filing a self-describing artifact with `snapshots: {}` and
// no log, and every deterministic criterion in it came back undecidable. That is
// not the engine's bug to fix in a package: the artifact is what THIS file
// promises, so this file takes its own capture and uses it wherever the loop's
// is missing. A twin that will not answer is written down as a twin that would
// not answer, at the time it would not.

export interface Capture {
  before: ByTwin<TwinSnapshot>;
  after: ByTwin<TwinSnapshot>;
  audit: TwinAuditRow[];
  /** Per twin, why the above is short. Travels into the artifact verbatim. */
  notes: Partial<Record<TwinName, string>>;
}

function newCapture(): Capture {
  return { before: {}, after: {}, audit: [], notes: {} };
}

/** The clones as the platform's own witness — stateless HTTP, so building costs nothing. */
function witnesses(twins: readonly TwinName[]): ByTwin<TwinAdapter> {
  const urls = twinUrlMap(twins);
  const map: ByTwin<TwinAdapter> = {};
  for (const adapter of createAdapters({
    ...(urls.gmail ? { gmail: { baseUrl: urls.gmail } } : {}),
    ...(urls.slack ? { slack: { baseUrl: urls.slack } } : {}),
    ...(urls.calendar ? { calendar: { baseUrl: urls.calendar } } : {}),
  })) {
    if (twins.includes(adapter.name)) map[adapter.name] = adapter;
  }
  return map;
}

/** "11:15" in the operator's own clock — a report quotes this, so it is local time. */
function atClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

async function snapshotInto(
  into: ByTwin<TwinSnapshot>,
  used: ByTwin<TwinAdapter>,
  capture: Capture,
): Promise<void> {
  for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
    if (into[name]) continue;
    try {
      into[name] = await adapter.snapshot();
    } catch (err) {
      // Not swallowed: the reason and the moment go on the record, so the report
      // can say the clone was unreachable at 11:15 rather than leave a reader to
      // read an empty checklist as the agent's silence.
      capture.notes[name] = `the ${name} clone was unreachable at ${atClock(Date.now())} (${message(err)})`;
    }
  }
}

/**
 * Every twin's write rows from the moment the day began.
 *
 * The floor is the first tick, never the run's start: seeding a cloned business
 * writes hundreds of rows, and crediting those to the agent is how a criterion
 * passes for free.
 */
async function auditFrom(
  used: ByTwin<TwinAdapter>,
  fromMs: number,
  capture: Capture,
): Promise<TwinAuditRow[]> {
  const rows: TwinAuditRow[] = [];
  for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
    try {
      rows.push(...(await adapter.auditSince(0)).filter((r) => r.ts >= fromMs));
    } catch (err) {
      capture.notes[name] ??= `the ${name} clone's audit log could not be read at ${atClock(Date.now())} (${message(err)})`;
    }
  }
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Fill in whatever the loop did not hand back, then close the record.
 *
 * The loop's own capture wins where it exists: its `before` was taken after
 * seeding and inside the same process that drove the day, and a second opinion
 * on a moment that has already passed would be a different moment.
 */
async function closeCapture(
  capture: Capture,
  used: ByTwin<TwinAdapter>,
  entry: LiveRun,
  result: EngineRunResult | null,
): Promise<Capture> {
  for (const [name, pair] of Object.entries(result?.run.snapshots ?? {}) as [
    TwinName,
    { before: TwinSnapshot; after: TwinSnapshot },
  ][]) {
    capture.before[name] = pair.before;
    capture.after[name] = pair.after;
  }
  await snapshotInto(capture.after, used, capture);
  explainUnpaired(capture, Object.keys(used) as TwinName[]);

  if (result && result.audit.length > 0) capture.audit = result.audit;
  else capture.audit = await auditFrom(used, entry.ticks[0]?.startedAt ?? entry.startedAt, capture);
  return capture;
}

/**
 * Say why a twin has a closing shot and no opening one.
 *
 * The `before` is taken in exactly two places — here, before the loop, or by the
 * loop itself after it seeds — and BOTH are skipped when a seeding loop unwinds
 * before its own capture, which is what a cancel at tick 0 does. `snapshotsOf`
 * then drops the half pair and the artifact files an empty map: a day nobody
 * photographed, wearing the face of a day in which nothing happened. Nothing
 * threw, so `snapshotInto` had nothing to report; the silence has to be named
 * here or it is never named at all.
 */
export function explainUnpaired(capture: Capture, twins: readonly TwinName[]): void {
  for (const twin of twins) {
    if (capture.notes[twin]) continue;
    if (capture.before[twin] && capture.after[twin]) continue;
    capture.notes[twin] = capture.before[twin]
      ? `the ${twin} clone gave no closing snapshot, so the opening one has nothing to be diffed against`
      : `the day ended before an opening snapshot of ${twin} was taken, so there is nothing to diff the closing one against`;
  }
}

/** Only pairs. A lone snapshot cannot be diffed, and half a pair reads as a whole one. */
function snapshotsOf(capture: Capture): EpisodeRun["snapshots"] {
  const out: EpisodeRun["snapshots"] = {};
  for (const name of Object.keys(capture.before) as TwinName[]) {
    const before = capture.before[name];
    const after = capture.after[name];
    if (before && after) out[name] = { before, after };
  }
  return out;
}

/** What the artifact says when the run never got far enough to have one. */
function partialRun(
  entry: LiveRun,
  spec: EpisodeSpec,
  status: RunStatus,
  capture: Capture,
): EpisodeRun {
  const audit = capture.audit;
  return {
    runId: entry.runId,
    specId: spec.id,
    specTitle: entry.title,
    model: entry.model,
    status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt ?? Date.now(),
    ticks: entry.ticks,
    // A day that fell over at 09:15 still changed the clones up to 09:15, and the
    // evidence for what it did is the reason it fell over. Empty here was never
    // honesty — it was a second failure on top of the first.
    snapshots: snapshotsOf(capture),
    ...(audit.length > 0 ? { audit } : {}),
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
  const used = witnesses(twins);
  const capture = newCapture();
  // The agent loop and the director both reach a model; a key typed into
  // Settings lives in platform.db and the engine cannot see it on its own.
  applyStoredApiKey();

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

    // The loop seeds only when no clone was loaded. When it does, the world does
    // not exist yet and a `before` taken here would picture an empty company —
    // the diff has to show what the AGENT changed, so the platform's own opening
    // shot is taken only once seeding is known to be finished, and the loop's is
    // the record for every other case.
    const seedsInLoop = clone ? false : wanted;
    if (!seedsInLoop) await snapshotInto(capture.before, used, capture);

    const result = await loop({
      spec,
      runId: entry.runId,
      model: entry.model,
      directorModel: input.directorModel?.trim() || settings.models.director,
      twins,
      twinUrls: twinUrlMap(twins),
      seedWorld: seedsInLoop,
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

    await closeCapture(capture, used, entry, result);
    return await complete(entry, result, spec, input, capture, twins);
  } catch (err) {
    // Before `fail` writes anything: the clones still hold whatever the day did
    // to them, and this is the last moment anyone can ask them.
    await closeCapture(capture, used, entry, null).catch(() => capture);
    return fail(entry, spec, err, capture, twins);
  }
}

async function complete(
  entry: LiveRun,
  result: EngineRunResult,
  spec: EpisodeSpec,
  input: StartEpisodeInput,
  capture: Capture,
  twins: TwinName[],
): Promise<EpisodeRun> {
  // The record the artifact is filed with, not the loop's report of it: the two
  // differ exactly when the loop unwound before its own capture, which is the
  // case this whole path exists for.
  const run: EpisodeRun = { ...result.run, snapshots: snapshotsOf(capture) };
  const status: RunStatus = entry.cancelled ? "aborted" : run.status === "failed" ? "failed" : "done";
  // Reconcile the ticks BEFORE scoring: autonomy reads the shape of the day, so a
  // loop that reported its ticks only through `onTick` would otherwise be scored
  // against an empty one and look like an agent that never moved.
  const ticks = run.ticks.length > 0 ? run.ticks : entry.ticks;
  // Scored as the status it is FINISHING with, not the one the loop returned: a
  // cancelled day is aborted, and `scoreRun` refuses to score a day that was cut
  // short as though the afternoon's criteria had had their chance.
  const { checklist, verdict, execution } = scoreRun({ ...run, status, ticks }, spec, {
    audit: capture.audit,
    cost: result.cost,
  });
  const scored: EpisodeRun = {
    ...run,
    status,
    endedAt: run.endedAt ?? Date.now(),
    ticks,
    // Saved with the run, because the checklist above is re-derived from this
    // artifact on every read and a re-derivation without the log turns real sends
    // into "no reply landed". The evidence that decided a row has to travel with
    // the row — and it is the same array `scoreRun` just read, so the file can
    // never disagree with the score printed beside it.
    audit: capture.audit,
    verdict,
    // A stopped day is not a broken one, and the engine's own note for it is the
    // sentinel above — which would read as a crash on the results page.
    ...(entry.cancelled ? { error: undefined } : {}),
  };

  // Null, not zero, when nothing was scored — the runs list and Home read these
  // straight through, and both have to be able to tell "did badly" from "we do
  // not know". The spend is known either way; it was paid either way.
  entry.score = verdict?.score ?? null;
  entry.autonomy = verdict?.autonomy ?? null;
  entry.cost = result.cost;

  // One terminal write for the row and the artifact together, through the same
  // function the rest of the dashboard finishes runs with.
  // `observed` because `closeCapture` always runs before this line: whatever is
  // missing from the map above, the clones were asked for it.
  mirrorRunFinish({
    run: scored,
    spec,
    checklist,
    cost: result.cost,
    twins,
    captureNotes: capture.notes,
    observed: true,
  });

  const wantsJudge = input.judge !== false && execution.executed && !entry.cancelled;
  if (wantsJudge) {
    entry.status = "judging";
    updateRunProgress(entry.runId, { status: "judging" });
    try {
      const judged = await judgeRun(scored, spec, {
        ...(input.judgeModel?.trim() ? { model: input.judgeModel.trim() } : {}),
        signal: entry.controller.signal,
      });
      entry.autonomy = judged.autonomy;
      // `wantsJudge` is only true for a run that executed, so there is a verdict
      // here; the guard is for the type, not for the case.
      if (verdict) scored.verdict = { ...verdict, autonomy: judged.autonomy, judge: judged.report };
    } catch (err) {
      // A judge that fails costs the run its diagnosis, not its score. The
      // checklist already ran, the artifact is already on disk, and the note
      // says what to retry with `sonata judge <runId>`.
      entry.error = `The day finished, but the judge did not: ${message(err)}`;
      finishRun({
        id: entry.runId,
        status,
        ...(verdict
          ? {
              outcome: verdict.outcome,
              score: verdict.score,
              autonomy: verdict.autonomy,
              costUsd: verdict.cost.usd,
            }
          : {}),
        error: entry.error,
        endedAt: scored.endedAt ?? Date.now(),
      });
    }
  }

  entry.status = status;
  entry.endedAt = scored.endedAt ?? Date.now();
  return scored;
}

function fail(
  entry: LiveRun,
  spec: EpisodeSpec,
  err: unknown,
  capture: Capture,
  twins: TwinName[],
): EpisodeRun {
  const status: RunStatus = entry.cancelled ? "aborted" : "failed";
  entry.error = message(err);
  entry.endedAt = Date.now();

  // Even a day that fell over at 09:15 is worth writing down: the ticks it did
  // record are usually the reason it fell over. It is not worth SCORING — the
  // status alone puts it outside `scoreRun`, so the verdict here is always null
  // and the row keeps its error instead of a number.
  const run = partialRun(entry, spec, status, capture);
  const { checklist, verdict } = scoreRun(run, spec, { audit: capture.audit });
  entry.score = verdict?.score ?? null;
  entry.autonomy = verdict?.autonomy ?? null;
  // One write, not two: `mirrorRunFinish` finishes the row itself, and the second
  // call is where a score could creep back in behind the artifact's back.
  mirrorRunFinish({
    run: { ...run, verdict },
    spec,
    checklist,
    twins,
    captureNotes: capture.notes,
    // The catch in `drive` closes the capture before it calls this, so even a day
    // that fell over at 09:15 asked the clones on its way down.
    observed: true,
  });
  // Terminal LAST. A poller that sees "failed" treats the run as finished and
  // reads its artifact; saying so before the artifact exists is how a caller
  // caches a broken day with no evidence attached to it.
  entry.status = status;
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
    // The row does not record which surfaces were attached, and the process that
    // knew died with the run — so this is the scenario's set, which is the most a
    // reader can be told honestly rather than a guess dressed as a fact.
    twins: getScenario(row.episodeId)?.twins ?? [],
    simTimeISO: row.simTime ?? "",
    lastEvent: row.lastEvent,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    score: row.score,
    autonomy: row.autonomy,
    // The row caches the dollars and nothing else. A breakdown with the tokens
    // guessed at would read as measured, so the artifact answers this or nobody
    // does — see `status`.
    cost: null,
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
  const verdict = saved?.verdict;
  return {
    run: verdict
      ? { ...run, score: verdict.score, autonomy: verdict.autonomy, cost: verdict.cost }
      : run,
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
