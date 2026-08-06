import {
  asVerdictOutcome,
  episodeTwins,
  plannedTicks,
  runExecution,
  tickToISO,
  type EpisodeRun,
  type EpisodeSpec,
  type RunStatus,
  type TickRecord,
  type TwinName,
} from "@sonata/core";
import { createAdapters, createDirector, traceCost } from "@sonata/engine";
import {
  createSession,
  realMsPerTick,
  type Session,
  type SessionRecord,
} from "@sonata/engine/session";
import { realTimer } from "@sonata/engine/live";
import { mirrorRunFinish } from "../../../app/api/_lib/mirror";
import { getEpisode, getWorld } from "../../../app/api/_lib/records";
import { newId } from "../../../app/api/_lib/store";
import type {
  SessionPoll,
  SessionScenario,
  SessionView,
  StartSessionInput,
} from "../../../app/api/sessions/_lib/types";
import { COMPRESSIONS } from "../../../app/api/sessions/_lib/types";
import { lastEventLine } from "../../../app/runs/_lib/story";
import { getDb, markWorldSeeded } from "../db";
import { getSettings } from "../settings";
import { applyStoredApiKey } from "./apiKey";
import { ensureTwins, loadClone, twinUrlMap } from "./preflight";
import { listScenarios, resolveScenario, specForRun } from "./scenarios";
import { briefFor, judgeRun, scoreRun } from "./verdict";

// PLUGGING AN AGENT IN, FROM THE DASHBOARD.
//
// `./episode` starts a day and drives the agent through it. This starts a day
// and drives nobody: @sonata/engine's `createSession` plays the same beats and
// the same director on a wall-clock timer at a declared compression, and the
// agent — OpenClaw, Claude Code, a customer's own harness — is on the outside,
// polling the twins on their own ports and acting when it decides to. What it
// did is read back out of the twins' audit logs, so this file never learns the
// agent exists and works with any of them.
//
// Written down in three places as it goes, for the same reasons `./episode` is:
//
//   - platform.db, in two tables of this file's own — one row per session and
//     one per tick. That is the only record that survives this process dying,
//     and it is why a dev-server reload does not cost an operator the morning
//     they have been watching.
//   - the registry below, which holds the live `Session` handle so `stop` and
//     `escalate` can find the day again. It hangs off `globalThis` because Next
//     re-evaluates route modules on every edit, and a module-level Map would
//     strand a running world on the first save.
//   - data/runs/<sessionId>.json at the end, written by `mirrorRunFinish` — the
//     same terminal write a run gets, so a session lands in Results beside the
//     benchmark and is re-judgeable months later with nothing live attached.
//
// A session ends as an `EpisodeRun` and is scored by `scoreRun` and `judgeRun`
// unchanged. There is deliberately no second scoring path: the checklist reads
// the twins and the judge reads the artifact, and neither ever knew who made the
// mutations.

// ---------------------------------------------------------------------------
// Marking. A session is not a benchmark result and must never be read as one.
// ---------------------------------------------------------------------------

/**
 * `EpisodeRun.model` for a session.
 *
 * The model column is where Results says what was under test, and for a session
 * there is no model to name — the agent is external, may be a scaffold over
 * several models, and is whatever the operator said it was. Prefixing it is what
 * stops a plugged-in session being read as a scored benchmark row: it sorts into
 * its own column in the pivot and reads as "plugged-in: openclaw@laptop" in the
 * table, rather than borrowing a slug it never ran on.
 */
export const SESSION_MODEL_PREFIX = "plugged-in:";

export function sessionModel(agentLabel: string): string {
  return `${SESSION_MODEL_PREFIX} ${agentLabel}`;
}

/** True for a run artifact produced by a plugged-in agent rather than a run. */
export function isSessionRun(model: string): boolean {
  return model.startsWith(SESSION_MODEL_PREFIX);
}

/**
 * The extra the artifact carries so a reader months later knows what they have.
 *
 * `EpisodeRun` has nowhere to say "the agent was not ours", and every one of
 * these caveats is a gap that reads as a finding about the agent if you do not
 * know it is a gap — so they go on the record beside the day itself.
 */
export interface SessionArtifact extends EpisodeRun {
  session: {
    sessionId: string;
    agentLabel: string;
    compression: number;
    endedBecause: string;
    longestIdleStreak: number;
    caveats: string[];
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Its own tables rather than the `runs` table a run uses. A session is not a run
// until it has finished: putting it in `runs` would put it in Home's live list
// and the runs index, both of which link to /runs/<id> — a page that reads a
// document store this never writes. It joins the shared record at the end, as an
// artifact, which is the only place the two kinds belong side by side.
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  episode_id           TEXT NOT NULL,
  title                TEXT NOT NULL,
  agent_label          TEXT NOT NULL,
  model                TEXT NOT NULL,
  status               TEXT NOT NULL,
  twins                TEXT NOT NULL,
  compression          REAL NOT NULL,
  sim_minutes_per_tick INTEGER NOT NULL,
  real_ms_per_tick     INTEGER NOT NULL,
  tick                 INTEGER NOT NULL DEFAULT 0,
  total_ticks          INTEGER NOT NULL,
  sim_time             TEXT,
  last_event           TEXT,
  beats                INTEGER NOT NULL DEFAULT 0,
  director_events      INTEGER NOT NULL DEFAULT 0,
  agent_actions        INTEGER NOT NULL DEFAULT 0,
  last_agent_at        INTEGER,
  idle_streak          INTEGER NOT NULL DEFAULT 0,
  longest_idle_streak  INTEGER NOT NULL DEFAULT 0,
  outcome              TEXT,
  score                REAL,
  autonomy             REAL,
  cost_usd             REAL NOT NULL DEFAULT 0,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  ended_because        TEXT,
  no_result            TEXT,
  caveats              TEXT,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at DESC);

-- Ticks as they land, not only at the end. The registry holds the day in
-- memory, and a process that dies takes the memory with it; a session runs for
-- minutes or hours, so this is the difference between a restart costing a
-- refresh and costing the whole morning.
CREATE TABLE IF NOT EXISTS session_ticks (
  session_id TEXT NOT NULL,
  tick       INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (session_id, tick)
);
`;

let schemaReady = false;

function db(): ReturnType<typeof getDb> {
  const handle = getDb();
  if (!schemaReady) {
    handle.exec(DDL);
    schemaReady = true;
  }
  return handle;
}

interface SessionRow {
  id: string;
  episode_id: string;
  title: string;
  agent_label: string;
  model: string;
  status: string;
  twins: string;
  compression: number;
  sim_minutes_per_tick: number;
  real_ms_per_tick: number;
  tick: number;
  total_ticks: number;
  sim_time: string | null;
  last_event: string | null;
  beats: number;
  director_events: number;
  agent_actions: number;
  last_agent_at: number | null;
  idle_streak: number;
  longest_idle_streak: number;
  outcome: string | null;
  score: number | null;
  autonomy: number | null;
  cost_usd: number;
  started_at: number;
  ended_at: number | null;
  ended_because: string | null;
  no_result: string | null;
  caveats: string | null;
  error: string | null;
}

const COLUMNS =
  "id, episode_id, title, agent_label, model, status, twins, compression, sim_minutes_per_tick, " +
  "real_ms_per_tick, tick, total_ticks, sim_time, last_event, beats, director_events, " +
  "agent_actions, last_agent_at, idle_streak, longest_idle_streak, outcome, score, autonomy, " +
  "cost_usd, started_at, ended_at, ended_because, no_result, caveats, error";

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "judging",
  "done",
  "failed",
  "aborted",
];

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toView(row: SessionRow, live: boolean, nextTickAt: number | null): SessionView {
  const status = RUN_STATUSES.find((s) => s === row.status) ?? "running";
  return {
    sessionId: row.id,
    episodeId: row.episode_id,
    title: row.title,
    agentLabel: row.agent_label,
    model: row.model,
    status,
    twins: parseList(row.twins) as TwinName[],
    tick: row.tick,
    plannedTicks: row.total_ticks,
    simTimeISO: row.sim_time ?? "",
    simMinutesPerTick: row.sim_minutes_per_tick,
    compression: row.compression,
    realMsPerTick: row.real_ms_per_tick,
    lastEvent: row.last_event,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    nextTickAt,
    beats: row.beats,
    directorEvents: row.director_events,
    agentActions: row.agent_actions,
    lastAgentActionAt: row.last_agent_at,
    idleStreak: row.idle_streak,
    longestIdleStreak: row.longest_idle_streak,
    outcome: asVerdictOutcome(row.outcome),
    score: row.score,
    autonomy: row.autonomy,
    costUsd: row.cost_usd,
    endedBecause: row.ended_because,
    noResult: row.no_result,
    error: row.error,
    caveats: parseList(row.caveats),
    live,
  };
}

function readRow(sessionId: string): SessionRow | null {
  return (
    (db().prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as
      | SessionRow
      | undefined) ?? null
  );
}

function readTicks(sessionId: string, from: number): TickRecord[] {
  const rows = db()
    .prepare("SELECT json FROM session_ticks WHERE session_id = ? AND tick >= ? ORDER BY tick")
    .all(sessionId, from) as Array<{ json: string }>;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.json) as TickRecord];
    } catch {
      // A half-written tick is a row the timeline skips, never a 500 on the page
      // that is watching the day it belongs to.
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface LiveSession {
  sessionId: string;
  episodeId: string;
  worldId: string;
  spec: EpisodeSpec;
  twins: TwinName[];
  agentLabel: string;
  compression: number;
  seedWorld: boolean;
  judge: boolean;
  /** Null until the world is up and tick 0 has fired. */
  session: Session | null;
  /**
   * Set by `stopSession`. Standing three twins up and loading a company into
   * them takes tens of seconds, and there is no `Session` to stop for all of it
   * — without this, stop would be silently ignored for the one window in which
   * an operator is most likely to press it.
   */
  stopRequested: string | null;
  /**
   * Resolves once the day has been scored and filed — before the judge, which
   * costs a model call. `stopSession` waits on this so the response to a stop
   * carries the finished row rather than the one the browser already had.
   */
  scored: Promise<void>;
  markScored: () => void;
  /** Resolves when the day has been scored, written and judged. */
  done: Promise<void>;
}

const g = globalThis as unknown as { __sonataLiveSessions?: Map<string, LiveSession> };

function registry(): Map<string, LiveSession> {
  if (!g.__sonataLiveSessions) g.__sonataLiveSessions = new Map();
  return g.__sonataLiveSessions;
}

function nextTickAtOf(entry: LiveSession | undefined): number | null {
  if (!entry?.session) return null;
  try {
    return entry.session.status(0).nextTickAt;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/** Below 1 the world would run slower than real time; above 3600 it is a blur. */
function clampCompression(value: number | undefined): number {
  const wanted = Number(value);
  if (!Number.isFinite(wanted) || wanted <= 0) return 60;
  return Math.max(1, Math.min(3600, wanted));
}

/**
 * Begin a session.
 *
 * Returns as soon as the row exists rather than when the world is up: seeding a
 * cloned business into three twins takes seconds, and the caller — a POST
 * handler — needs an id to send the browser to. Everything after this happens on
 * `entry.done`.
 */
export function startSession(input: StartSessionInput): SessionView {
  // One world at a time. The three clones are shared and a session resets and
  // reloads them, so a second day started now would wipe the first one's
  // evidence out from under it — and the two sets of beats would land in one
  // inbox, which is not a scenario anybody wrote.
  // Judging is not "running": the world is over and the twins are free by then,
  // so a day being read back must not hold the next one up for a model call.
  const busy = [...registry().values()].find((live) => {
    const status = readRow(live.sessionId)?.status;
    return status === "queued" || status === "running";
  });
  if (busy) {
    throw new Error(
      `A session is already running: ${busy.spec.title}. Stop it before starting another — all three clones are shared, and a second day would reset the world out from under the first.`,
    );
  }

  const episode = resolveScenario(input.episodeId);
  const spec = specForRun(episode.spec, input.ticks);

  // The request can only narrow the surfaces the scenario actually uses:
  // attaching a twin the day never touches costs a boot and teaches nothing.
  const wanted = input.twins?.length ? input.twins : episodeTwins(spec);
  const needed = episodeTwins(spec).filter((t) => wanted.includes(t));
  const twins = needed.length > 0 ? needed : episodeTwins(spec);

  const compression = clampCompression(input.compression);
  const agentLabel = input.agentLabel?.trim() || "an external agent";
  const sessionId = newId("sess");
  const total = plannedTicks(spec);
  const now = Date.now();

  db()
    .prepare(
      `INSERT INTO sessions (id, episode_id, title, agent_label, model, status, twins, compression,
                             sim_minutes_per_tick, real_ms_per_tick, tick, total_ticks, sim_time,
                             started_at)
       VALUES (@id, @episode_id, @title, @agent_label, @model, 'queued', @twins, @compression,
               @sim_minutes_per_tick, @real_ms_per_tick, 0, @total_ticks, @sim_time, @started_at)`,
    )
    .run({
      id: sessionId,
      episode_id: episode.id,
      title: episode.title,
      agent_label: agentLabel,
      model: sessionModel(agentLabel),
      twins: JSON.stringify(twins),
      compression,
      sim_minutes_per_tick: spec.clock.simMinutesPerTick,
      real_ms_per_tick: Math.round(realMsPerTick(spec.clock, compression)),
      total_ticks: total,
      sim_time: tickToISO(spec.clock, 0),
      started_at: now,
    });

  let markScored: () => void = () => undefined;
  const scored = new Promise<void>((resolve) => {
    markScored = resolve;
  });

  const base: Omit<LiveSession, "done"> = {
    sessionId,
    episodeId: episode.id,
    worldId: episode.worldId,
    spec,
    twins,
    agentLabel,
    compression,
    seedWorld: input.seedWorld ?? true,
    judge: input.judge !== false,
    session: null,
    stopRequested: null,
    scored,
    markScored,
  };
  // The driver mutates the entry as the day plays, so it has to exist before the
  // promise that fills it in — hence the two steps.
  const entry = base as LiveSession;
  registry().set(sessionId, entry);
  entry.done = drive(entry);
  // The driver owns every failure and writes it to the row; this only stops an
  // unhandled rejection from taking the dev server down with it.
  entry.done.catch(() => undefined);

  const row = readRow(sessionId);
  if (!row) throw new Error(`session ${sessionId} vanished immediately after being started`);
  return toView(row, true, null);
}

// ---------------------------------------------------------------------------
// The day itself
// ---------------------------------------------------------------------------

function saveTick(entry: LiveSession, record: TickRecord): void {
  // Two different questions, so two different numbers. `changes` is what the
  // twins can prove — the audit rows, and nothing else. `acted` includes a
  // hand-back reported by the harness, which changes nothing in the world but is
  // emphatically not silence, and counting it as a change would put a mutation
  // on the record that never happened.
  const changes = record.agentSteps.filter((step) => step.kind === "tool").length;
  const acted = record.agentSteps.length > 0;
  const line = lastEventLine(record);
  const now = Date.now();

  const write = db().transaction(() => {
    db()
      .prepare("INSERT OR REPLACE INTO session_ticks (session_id, tick, json) VALUES (?, ?, ?)")
      .run(entry.sessionId, record.tick, JSON.stringify(record));
    db()
      .prepare(
        `UPDATE sessions SET
           status = 'running',
           tick = @tick,
           sim_time = @sim_time,
           last_event = COALESCE(@last_event, last_event),
           beats = beats + @beats,
           director_events = director_events + @director_events,
           agent_actions = agent_actions + @agent_actions,
           last_agent_at = CASE WHEN @acted = 1 THEN @now ELSE last_agent_at END,
           idle_streak = CASE WHEN @acted = 1 THEN 0 ELSE idle_streak + 1 END,
           longest_idle_streak =
             MAX(longest_idle_streak, CASE WHEN @acted = 1 THEN 0 ELSE idle_streak + 1 END)
         WHERE id = @id`,
      )
      .run({
        id: entry.sessionId,
        tick: record.tick + 1,
        sim_time: record.simTimeISO,
        last_event: line,
        beats: record.beatsFired.length,
        director_events: record.directorEvents.length,
        agent_actions: changes,
        acted: acted ? 1 : 0,
        now,
      });
  });

  try {
    write();
  } catch (err) {
    // A tick that could not be written is a gap in the replay, never the end of
    // the day: the world is still running and the agent is still working.
    console.warn(`[sonata] could not persist tick ${record.tick} of ${entry.sessionId}:`, message(err));
  }
}

async function drive(entry: LiveSession): Promise<void> {
  const settings = getSettings();
  // Before the first director tick, not after: a world whose director cannot
  // reach a model still fires its beats, so the failure hides as a day that
  // simply never answers the agent.
  applyStoredApiKey();
  try {
    await ensureTwins(entry.twins);
    if (entry.stopRequested !== null) return abortBeforeStart(entry, entry.stopRequested);

    // The cloned business, whole, exactly as `./episode` loads it: an
    // `EpisodeSpec` carries a cast and a day but no history, so seeding from it
    // alone leaves the agent opening an empty inbox in a company that is
    // supposed to have been running for weeks. `injectWorld` resets each twin as
    // part of loading, so the session must not then reset back over it.
    const clone = entry.seedWorld ? getWorld(entry.worldId)?.clone : undefined;
    if (clone) {
      note(entry.sessionId, "loading the cloned business into the twins");
      await loadClone(clone, entry.twins);
      if (entry.stopRequested !== null) return abortBeforeStart(entry, entry.stopRequested);
    }

    const urls = twinUrlMap(entry.twins);
    const adapters = createAdapters({
      ...(urls.gmail ? { gmail: { baseUrl: urls.gmail } } : {}),
      ...(urls.slack ? { slack: { baseUrl: urls.slack } } : {}),
      ...(urls.calendar ? { calendar: { baseUrl: urls.calendar } } : {}),
    }).filter((adapter) => entry.twins.includes(adapter.name));

    const session = createSession({
      spec: entry.spec,
      adapters,
      compression: entry.compression,
      timer: realTimer(),
      sessionId: entry.sessionId,
      // The world's own voice, on the harness's model — never the agent's. The
      // director does not know and does not need to know that the mutations it
      // is reacting to came from someone else's process.
      director: createDirector({ spec: entry.spec, model: settings.models.director }),
      agentLabel: sessionModel(entry.agentLabel),
      seedWorld: clone ? false : entry.seedWorld,
      resetTwins: clone ? false : entry.seedWorld,
      onTick: (record) => saveTick(entry, record),
    });
    entry.session = session;

    if (entry.stopRequested === null) {
      await session.start();
      if (entry.seedWorld) markWorldSeeded(entry.worldId);
    }
    // Stopped while the world was being stood up, or during tick 0. `stop` is
    // idempotent and a session that never started ends `aborted` either way, so
    // this is the same path as a stop an hour in.
    if (entry.stopRequested !== null) await session.stop(entry.stopRequested);

    await settle(entry, await session.finished());
  } catch (err) {
    fail(entry, err);
  } finally {
    // Always, however the day ended: a caller waiting on the score must never be
    // left waiting by a path that failed on its way there.
    entry.markScored();
    registry().delete(entry.sessionId);
  }
}

/**
 * Stopped before there was a day. No ticks, no snapshots, nothing the twins can
 * be asked about — so the row is closed and no artifact is written. An empty
 * artifact in Results is a run that looks like it happened.
 */
function abortBeforeStart(entry: LiveSession, reason: string): void {
  finishRow(entry.sessionId, {
    status: "aborted",
    endedAt: Date.now(),
    endedBecause: reason,
    noResult: "The day never started — the agent never ran, so there is no result.",
    caveats: [],
  });
}

function note(sessionId: string, line: string): void {
  db().prepare("UPDATE sessions SET last_event = ? WHERE id = ?").run(line, sessionId);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One reason, told about every attached twin — the artifact's `captureNotes`. */
function noteForAll(twins: readonly TwinName[], why: string): Partial<Record<TwinName, string>> {
  const notes: Partial<Record<TwinName, string>> = {};
  for (const twin of twins) notes[twin] = why;
  return notes;
}

/**
 * Which attached twins came back without a usable pair, and that they did.
 *
 * The session's snapshots are the engine's, and @sonata/engine takes them with a
 * swallowed catch — one clone that will not answer is deliberately not allowed to
 * cost the whole day. The cost lands here instead: a twin missing from the map
 * with nothing said about it reads as a surface the agent never touched.
 */
function unpairedNotes(
  twins: readonly TwinName[],
  snapshots: EpisodeRun["snapshots"],
): Partial<Record<TwinName, string>> {
  const notes: Partial<Record<TwinName, string>> = {};
  for (const twin of twins) {
    const pair = snapshots[twin];
    if (pair?.before && pair.after) continue;
    notes[twin] = `no snapshot pair came back from the ${twin} clone while the session ran, so its criteria cannot be decided from this file`;
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Finishing — the same scoring a run gets, and deliberately no other
// ---------------------------------------------------------------------------

async function settle(entry: LiveSession, record: SessionRecord): Promise<void> {
  const run = record.run;
  // The engine has already decided: `done` at the end of the day, `aborted` for
  // a stop, `failed` for a world that never came up.
  const status = run.status;
  const cost = traceCost(record.trace);
  const { checklist, verdict, execution } = scoreRun(run, entry.spec, {
    audit: record.audit,
    cost,
  });

  const scored: SessionArtifact = {
    ...run,
    endedAt: run.endedAt ?? Date.now(),
    // The log the checklist above just read, filed beside the score it produced.
    // Without it the artifact is re-derived months later against less evidence
    // than decided it, and a reply that really went out reads as "no reply
    // landed" — see `EpisodeRun.audit`.
    audit: record.audit,
    verdict,
    session: {
      sessionId: entry.sessionId,
      agentLabel: entry.agentLabel,
      compression: entry.compression,
      endedBecause: record.endedBecause,
      longestIdleStreak: readRow(entry.sessionId)?.longest_idle_streak ?? 0,
      caveats: record.caveats,
    },
  };

  // The artifact, through the same terminal write every run in the product
  // finishes with — which is what puts a session in Results with no second
  // writer to disagree with it. Its other half, the `runs` row, is a no-op here:
  // a session never had one, on purpose (see the DDL above), and the update
  // simply matches nothing.
  mirrorRunFinish({
    run: scored,
    spec: entry.spec,
    checklist,
    cost,
    twins: entry.twins,
    captureNotes: unpairedNotes(entry.twins, run.snapshots),
    observed: true,
  });

  finishRow(entry.sessionId, {
    status,
    endedAt: scored.endedAt ?? Date.now(),
    endedBecause: record.endedBecause,
    noResult: execution.reason,
    caveats: record.caveats,
    costUsd: cost.usd,
    ...(verdict
      ? { outcome: verdict.outcome, score: verdict.score, autonomy: verdict.autonomy }
      : {}),
    ...(run.error ? { error: run.error } : {}),
  });
  entry.markScored();

  // The judge reads the artifact, so it can only run on a day that was in a
  // state to have earned one — a session stopped at 11:00 is not scored, for the
  // same reason a run stopped at 11:00 is not: the afternoon's criteria never had
  // their chance, and the negative ones it "passed" by being cut short are not
  // facts about the agent.
  if (!entry.judge || !execution.executed) return;

  db().prepare("UPDATE sessions SET status = 'judging' WHERE id = ?").run(entry.sessionId);
  try {
    const judged = await judgeRun(scored, briefFor(entry.spec));
    db()
      .prepare("UPDATE sessions SET status = ?, autonomy = ? WHERE id = ?")
      .run(status, judged.autonomy, entry.sessionId);
  } catch (err) {
    // A judge that fails costs the session its diagnosis, not its score. The
    // checklist already ran and the artifact is already on disk.
    db()
      .prepare("UPDATE sessions SET status = ?, error = ? WHERE id = ?")
      .run(status, `The day finished, but the judge did not: ${message(err)}`, entry.sessionId);
  }
}

function fail(entry: LiveSession, err: unknown): void {
  const reason = message(err);
  const ticks = readTicks(entry.sessionId, 0);
  const row = readRow(entry.sessionId);
  const status: RunStatus = "failed";

  // Even a session that fell over standing the twins up is worth writing down:
  // the ticks it did record are usually the reason. It is not worth SCORING —
  // the status alone puts it outside `scoreRun`.
  const run: EpisodeRun = {
    runId: entry.sessionId,
    specId: entry.spec.id,
    specTitle: entry.spec.title,
    model: sessionModel(entry.agentLabel),
    status,
    startedAt: row?.started_at ?? Date.now(),
    endedAt: Date.now(),
    ticks,
    snapshots: {},
    verdict: null,
    error: reason,
  };
  const { checklist } = scoreRun(run, entry.spec);
  // Why there are no snapshots, per twin, rather than an empty object a reader
  // has to guess at: a session fails standing the world up, so nothing was ever
  // observable and every deterministic criterion below is undecidable for OUR
  // reason. That sentence belongs in the artifact, not in a maintainer's head.
  mirrorRunFinish({
    run,
    spec: entry.spec,
    checklist,
    twins: entry.twins,
    captureNotes: noteForAll(entry.twins, `the session stopped before the day began: ${reason}`),
    observed: false,
  });

  finishRow(entry.sessionId, {
    status,
    endedAt: run.endedAt ?? Date.now(),
    endedBecause: `the session stopped: ${reason}`,
    noResult: runExecution(run).reason,
    caveats: [],
    error: reason,
  });
}

function finishRow(
  sessionId: string,
  input: {
    status: RunStatus;
    endedAt: number;
    endedBecause: string;
    noResult: string | null;
    caveats: string[];
    costUsd?: number;
    outcome?: string;
    score?: number;
    autonomy?: number;
    error?: string;
  },
): void {
  try {
    db()
      .prepare(
        `UPDATE sessions SET status = @status, ended_at = @ended_at, ended_because = @ended_because,
                no_result = @no_result, caveats = @caveats,
                cost_usd = COALESCE(@cost_usd, cost_usd), outcome = @outcome, score = @score,
                autonomy = @autonomy, error = COALESCE(@error, error)
         WHERE id = @id`,
      )
      .run({
        id: sessionId,
        status: input.status,
        ended_at: input.endedAt,
        ended_because: input.endedBecause,
        no_result: input.noResult,
        caveats: JSON.stringify(input.caveats),
        cost_usd: input.costUsd ?? null,
        outcome: input.outcome ?? null,
        score: input.score ?? null,
        autonomy: input.autonomy ?? null,
        error: input.error ?? null,
      });
  } catch (err) {
    console.warn(`[sonata] could not finish session ${sessionId}:`, message(err));
  }
}

// ---------------------------------------------------------------------------
// Watching, stopping, and the one thing the audit log cannot see
// ---------------------------------------------------------------------------

/**
 * Sessions this process is no longer running, but the row still calls live.
 *
 * A session is a wall-clock timer and a `Session` in memory; a restart takes
 * both, and nothing is left to advance the day. The honest thing is to stop
 * calling it running — and because every tick was written as it landed, the day
 * up to the restart is still a real artifact, so it is scored and filed rather
 * than thrown away. It is `aborted`, so `scoreRun` refuses it a score, which is
 * correct: the afternoon never happened.
 */
export function sweepOrphanSessions(): void {
  const rows = db()
    .prepare(
      `SELECT ${COLUMNS} FROM sessions WHERE status IN ('queued','running','judging')`,
    )
    .all() as SessionRow[];

  for (const row of rows) {
    if (registry().has(row.id)) continue;
    const reason = "the dashboard restarted while the day was running";
    const ticks = readTicks(row.id, 0);
    const spec = specSnapshot(row);
    const run: EpisodeRun = {
      runId: row.id,
      specId: row.episode_id,
      specTitle: row.title,
      model: row.model,
      status: "aborted",
      startedAt: row.started_at,
      endedAt: Date.now(),
      ticks,
      snapshots: {},
      verdict: null,
    };
    if (spec) {
      const { checklist } = scoreRun(run, spec);
      const twins = parseList(row.twins) as TwinName[];
      // Deliberately NOT captured here, late as it is: the three clones are
      // shared, a restart is exactly when the next day resets them, and an
      // after-snapshot taken now could file someone else's morning as this
      // session's evidence. Saying so is the honest record.
      mirrorRunFinish({
        run,
        spec,
        checklist,
        twins,
        captureNotes: noteForAll(twins, `${reason}, so the closing snapshot was never taken`),
        observed: false,
      });
    }
    finishRow(row.id, {
      status: "aborted",
      endedAt: run.endedAt ?? Date.now(),
      endedBecause: reason,
      noResult: runExecution(run).reason,
      caveats: [],
    });
  }
}

/** The spec as this session ran it, for a row whose driver is gone. */
function specSnapshot(row: SessionRow): EpisodeSpec | null {
  try {
    return specForRun(resolveScenario(row.episode_id).spec, row.total_ticks);
  } catch {
    // The scenario was deleted after the session started. The ticks are still
    // the record; they simply cannot be scored against criteria nobody has.
    return null;
  }
}

/** Where a session has got to, and the ticks the caller has not seen. */
export function sessionStatus(sessionId: string, sinceTick = 0): SessionPoll | null {
  const row = readRow(sessionId);
  if (!row) return null;
  const entry = registry().get(sessionId);
  const from = Math.max(0, Math.floor(sinceTick));
  const ticks = readTicks(sessionId, from);
  const last = ticks[ticks.length - 1];
  return {
    session: toView(row, Boolean(entry), nextTickAtOf(entry)),
    ticks,
    // The watermark comes from the ticks actually handed over, never from the
    // row's counter: a tick whose write failed would otherwise advance the
    // watermark past a tick the caller never received.
    nextSinceTick: last ? last.tick + 1 : from,
    at: Date.now(),
  };
}

/** Every session, newest first. */
export function listSessions(limit = 40): SessionView[] {
  const rows = db()
    .prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as SessionRow[];
  return rows.map((row) => {
    const entry = registry().get(row.id);
    return toView(row, Boolean(entry), nextTickAtOf(entry));
  });
}

/**
 * End a session early.
 *
 * The stop reaches the engine between ticks, so the day ends on a tick boundary
 * and still writes its artifact. Scoring and judging then happen on
 * `entry.done`, which is why this does not wait for them: reading a day back
 * costs a model call, and a stop button that hangs for thirty seconds is a stop
 * button people press twice.
 */
export async function stopSession(sessionId: string, reason?: string): Promise<SessionView | null> {
  const row = readRow(sessionId);
  if (!row) return null;

  const stopped = reason ?? "an operator stopped the session";
  const entry = registry().get(sessionId);
  if (!entry) {
    // Started by a process that is now gone. Nothing here is advancing it, so it
    // must stop calling itself running.
    if (["queued", "running", "judging"].includes(row.status)) sweepOrphanSessions();
    return sessionStatus(sessionId)?.session ?? null;
  }

  entry.stopRequested = stopped;
  // No session yet means the twins are still being stood up. The driver picks
  // the request up the moment there is something to stop, and this returns now
  // rather than holding the request open for a ninety-second `next dev` boot.
  if (entry.session) {
    await entry.session.stop(stopped);
    // The record, not the row the browser already had. Scoring is synchronous
    // work on ticks that are already in hand; the judge, which is not, runs on
    // after this returns.
    await entry.scored;
  }
  return sessionStatus(sessionId)?.session ?? null;
}

/**
 * Record that the agent handed the job back to a human.
 *
 * A hand-back touches no twin, so it leaves no audit row and a session cannot
 * see it. Whatever sits in front of the agent — an MCP server exposing an
 * `escalate_to_owner` tool — posts it here, and until something does, a
 * session's escalation count is zero and the autonomy score reads the agent as
 * fully independent. That is on the artifact's caveat list rather than papered
 * over.
 */
export function escalate(sessionId: string, text: string): boolean {
  const entry = registry().get(sessionId);
  if (!entry?.session) return false;
  entry.session.escalate(text);
  return true;
}

// ---------------------------------------------------------------------------
// What the start panel needs
// ---------------------------------------------------------------------------

/**
 * The scenarios a session can run, each priced in real time at every rate.
 *
 * The arithmetic is the engine's own `realMsPerTick`, done here rather than in
 * the browser: the estimate an operator commits an afternoon to and the interval
 * the scheduler actually uses must be the same number.
 */
export function sessionScenarios(): SessionScenario[] {
  return listScenarios().flatMap((episode) => {
    // The summary list carries no clock, and the day's grain is what every
    // duration on the panel is derived from, so a scenario whose spec cannot be
    // read is left off rather than shown with a made-up one.
    const clock = getEpisode(episode.id)?.spec.clock;
    if (!clock) return [];
    return [
      {
        id: episode.id,
        title: episode.title,
        story: episode.story,
        twins: episode.twins,
        ticks: episode.counts.ticks,
        simMinutesPerTick: clock.simMinutesPerTick,
        realMs: COMPRESSIONS.map((option) => ({
          factor: option.factor,
          ms: Math.round(episode.counts.ticks * realMsPerTick(clock, option.factor)),
        })),
      },
    ];
  });
}
