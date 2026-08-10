import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { EpisodeSpec, RunStatus, TwinName, VerdictOutcome, WorldSeed } from "@sonata/core";

// platform.db — the dashboard's own store. The twins each keep three databases
// (snapshot / working / audit) because they get reset between runs; the platform
// keeps one, because none of this is ever reset: worlds and runs are the record.
//
// Path is cwd-relative like the twins, so `npm run dev -w apps/platform` and the
// CLIs agree on one file without an env var.

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const PLATFORM_DB_PATH = path.join(DATA_DIR, "platform.db");

// Big JSON columns (`seed_json`, `spec_json`, `run_json`) hold the @sonata/core
// artifacts verbatim. Keeping them whole is what lets a finished run be
// re-judged months later with nothing live attached; the scalar columns beside
// them exist only so a list page renders without parsing megabytes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  cast_size INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER NOT NULL DEFAULT 0,
  seed_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seeded_at INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  story TEXT NOT NULL,
  template_id TEXT,
  twins TEXT NOT NULL,
  ticks INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_world ON episodes (world_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_title TEXT NOT NULL,
  world_name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  tick INTEGER NOT NULL DEFAULT 0,
  total_ticks INTEGER NOT NULL,
  sim_time TEXT,
  last_event TEXT,
  outcome TEXT,
  score REAL,
  autonomy REAL,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT,
  run_json TEXT,
  -- Who is driving this run, and when they last said so. Both are cleared the
  -- moment the run ends: a terminal row has no owner. See "Liveness" below.
  owner_pid INTEGER,
  owner_host TEXT,
  heartbeat_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Twin child processes the dashboard started. A pid on disk (rather than only
-- in memory) is what lets a dev-server reload re-adopt a running twin instead of
-- orphaning it on a port it will then refuse to rebind.
CREATE TABLE IF NOT EXISTS twin_processes (
  twin TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  log_path TEXT NOT NULL
);
`;

// Columns added to `runs` after the table shipped. `CREATE TABLE IF NOT EXISTS`
// is a no-op on an existing database, so a new column has to be added here too
// or every install that predates it reads as a database with no ownership at
// all — which is how a run from yesterday claimed to still be running.
const ADDED_RUN_COLUMNS: Readonly<Record<string, string>> = {
  owner_pid: "owner_pid INTEGER",
  owner_host: "owner_host TEXT",
  heartbeat_at: "heartbeat_at INTEGER",
};

/** Bumped whenever `ADDED_RUN_COLUMNS` grows. See `getDb`. */
const SCHEMA_VERSION = 2;

type Db = Database.Database;

// Next's dev server re-evaluates modules on every edit; without the singleton
// each reload would leak a file handle.
const g = globalThis as unknown as { __sonataPlatformDb?: Db; __sonataPlatformSchema?: number };

function migrate(db: Db): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, ddl] of Object.entries(ADDED_RUN_COLUMNS)) {
    if (!present.has(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${ddl}`);
  }
  g.__sonataPlatformSchema = SCHEMA_VERSION;
}

function open(): Db {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(PLATFORM_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The CLI, the benchmark runner and the web server all write this file. A
  // writer that arrives mid-write should wait rather than fail the run.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getDb(): Db {
  if (!g.__sonataPlatformDb) {
    // Installed before reconciling, because the reconciler reads and writes
    // through this same accessor.
    g.__sonataPlatformDb = open();
    // Start-up reconciliation, for whichever process opens the file first — a
    // web server, a CLI, a test. A run interrupted by a crash must not have to
    // wait for someone to visit the right page before it stops claiming to run.
    reconcileLiveRuns();
  } else if (g.__sonataPlatformSchema !== SCHEMA_VERSION) {
    // The handle outlives the module that opened it, so a dev server that has
    // hot-reloaded into this version is still holding a connection opened by the
    // one before it — and would query a column that no ALTER has added yet.
    migrate(g.__sonataPlatformDb);
  }
  return g.__sonataPlatformDb;
}

export function closeDb(): void {
  if (g.__sonataPlatformDb) {
    g.__sonataPlatformDb.close();
    g.__sonataPlatformDb = undefined;
  }
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

export interface World {
  id: string;
  name: string;
  description: string;
  industry: string;
  /** The sentence the user typed to clone the business. */
  prompt: string;
  castSize: number;
  channelCount: number;
  createdAt: number;
  /** When this world was last pushed into the twins; null = never seeded. */
  seededAt: number | null;
}

interface WorldRow {
  id: string;
  name: string;
  description: string;
  industry: string;
  prompt: string;
  cast_size: number;
  channel_count: number;
  created_at: number;
  seeded_at: number | null;
}

const WORLD_COLUMNS =
  "id, name, description, industry, prompt, cast_size, channel_count, created_at, seeded_at";

function toWorld(row: WorldRow): World {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    industry: row.industry,
    prompt: row.prompt,
    castSize: row.cast_size,
    channelCount: row.channel_count,
    createdAt: row.created_at,
    seededAt: row.seeded_at,
  };
}

export function saveWorld(input: {
  id: string;
  seed: WorldSeed;
  prompt?: string;
  createdAt?: number;
}): World {
  const { id, seed } = input;
  getDb()
    .prepare(
      `INSERT INTO worlds (id, name, description, industry, prompt, cast_size, channel_count,
                           seed_json, created_at, seeded_at)
       VALUES (@id, @name, @description, @industry, @prompt, @cast_size, @channel_count,
               @seed_json, @created_at, NULL)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description, industry = excluded.industry,
         prompt = excluded.prompt, cast_size = excluded.cast_size,
         channel_count = excluded.channel_count, seed_json = excluded.seed_json`,
    )
    .run({
      id,
      name: seed.business.name,
      description: seed.business.description,
      industry: seed.business.industry,
      prompt: input.prompt ?? "",
      cast_size: seed.cast.length,
      channel_count: seed.channels.length,
      seed_json: JSON.stringify(seed),
      created_at: input.createdAt ?? Date.now(),
    });
  const world = getWorld(id);
  if (!world) throw new Error(`world ${id} vanished immediately after being saved`);
  return world;
}

export function getWorld(id: string): World | null {
  const row = getDb()
    .prepare(`SELECT ${WORLD_COLUMNS} FROM worlds WHERE id = ?`)
    .get(id) as WorldRow | undefined;
  return row ? toWorld(row) : null;
}

export function getWorldSeed(id: string): WorldSeed | null {
  const row = getDb().prepare("SELECT seed_json FROM worlds WHERE id = ?").get(id) as
    | { seed_json: string }
    | undefined;
  return row ? (JSON.parse(row.seed_json) as WorldSeed) : null;
}

export function listWorlds(): World[] {
  const rows = getDb()
    .prepare(`SELECT ${WORLD_COLUMNS} FROM worlds ORDER BY created_at DESC`)
    .all() as WorldRow[];
  return rows.map(toWorld);
}

export function markWorldSeeded(id: string, at: number = Date.now()): void {
  getDb().prepare("UPDATE worlds SET seeded_at = ? WHERE id = ?").run(at, id);
}

export function countWorlds(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM worlds").get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface Episode {
  id: string;
  worldId: string;
  title: string;
  story: string;
  /** Which of the five stock stories this came from, when it came from one. */
  templateId: string | null;
  /** Surfaces the episode actually touches, derived by `episodeTwins`. */
  twins: TwinName[];
  ticks: number;
  createdAt: number;
}

interface EpisodeRow {
  id: string;
  world_id: string;
  title: string;
  story: string;
  template_id: string | null;
  twins: string;
  ticks: number;
  created_at: number;
}

const EPISODE_COLUMNS = "id, world_id, title, story, template_id, twins, ticks, created_at";

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    worldId: row.world_id,
    title: row.title,
    story: row.story,
    templateId: row.template_id,
    twins: row.twins ? (row.twins.split(",") as TwinName[]) : [],
    ticks: row.ticks,
    createdAt: row.created_at,
  };
}

export function saveEpisode(input: {
  worldId: string;
  spec: EpisodeSpec;
  twins: TwinName[];
  templateId?: string;
  createdAt?: number;
}): Episode {
  const { spec } = input;
  getDb()
    .prepare(
      `INSERT INTO episodes (id, world_id, title, story, template_id, twins, ticks, spec_json, created_at)
       VALUES (@id, @world_id, @title, @story, @template_id, @twins, @ticks, @spec_json, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         world_id = excluded.world_id, title = excluded.title, story = excluded.story,
         template_id = excluded.template_id, twins = excluded.twins, ticks = excluded.ticks,
         spec_json = excluded.spec_json`,
    )
    .run({
      id: spec.id,
      world_id: input.worldId,
      title: spec.title,
      story: spec.story,
      template_id: input.templateId ?? null,
      twins: input.twins.join(","),
      ticks: spec.clock.ticks,
      spec_json: JSON.stringify(spec),
      created_at: input.createdAt ?? Date.now(),
    });
  const episode = getEpisode(spec.id);
  if (!episode) throw new Error(`episode ${spec.id} vanished immediately after being saved`);
  return episode;
}

export function getEpisode(id: string): Episode | null {
  const row = getDb()
    .prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes WHERE id = ?`)
    .get(id) as EpisodeRow | undefined;
  return row ? toEpisode(row) : null;
}

export function getEpisodeSpec(id: string): EpisodeSpec | null {
  const row = getDb().prepare("SELECT spec_json FROM episodes WHERE id = ?").get(id) as
    | { spec_json: string }
    | undefined;
  return row ? (JSON.parse(row.spec_json) as EpisodeSpec) : null;
}

export function listEpisodes(worldId?: string): Episode[] {
  const db = getDb();
  const rows = (
    worldId
      ? db
          .prepare(
            `SELECT ${EPISODE_COLUMNS} FROM episodes WHERE world_id = ? ORDER BY created_at DESC`,
          )
          .all(worldId)
      : db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes ORDER BY created_at DESC`).all()
  ) as EpisodeRow[];
  return rows.map(toEpisode);
}

export function countEpisodes(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Runs. The engine writes progress here every tick; the dashboard polls it.
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  episodeId: string;
  episodeTitle: string;
  worldName: string;
  model: string;
  status: RunStatus;
  /** Tick the run is on now, 0-based. */
  tick: number;
  totalTicks: number;
  /** Simulated time at the current tick, ISO with offset. */
  simTime: string | null;
  /** One line for the overview card: the last thing that happened. */
  lastEvent: string | null;
  outcome: VerdictOutcome | null;
  score: number | null;
  autonomy: number | null;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

interface RunRow {
  id: string;
  episode_id: string;
  episode_title: string;
  world_name: string;
  model: string;
  status: string;
  tick: number;
  total_ticks: number;
  sim_time: string | null;
  last_event: string | null;
  outcome: string | null;
  score: number | null;
  autonomy: number | null;
  cost_usd: number;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: number | null;
}

const RUN_COLUMNS =
  "id, episode_id, episode_title, world_name, model, status, tick, total_ticks, sim_time, " +
  "last_event, outcome, score, autonomy, cost_usd, started_at, ended_at, error, " +
  "owner_pid, owner_host, heartbeat_at";

function toRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    episodeId: row.episode_id,
    episodeTitle: row.episode_title,
    worldName: row.world_name,
    model: row.model,
    status: row.status as RunStatus,
    tick: row.tick,
    totalTicks: row.total_ticks,
    simTime: row.sim_time,
    lastEvent: row.last_event,
    outcome: row.outcome as RunSummary["outcome"],
    score: row.score,
    autonomy: row.autonomy,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
  };
}

export function createRun(input: {
  id: string;
  episodeId: string;
  episodeTitle: string;
  worldName?: string;
  model: string;
  totalTicks: number;
  status?: RunStatus;
  startedAt?: number;
  /** The process that will drive it. Omitted ⇒ nobody claims to be. */
  owner?: RunOwner;
}): RunSummary {
  const startedAt = input.startedAt ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO runs (id, episode_id, episode_title, world_name, model, status, tick,
                         total_ticks, started_at, owner_pid, owner_host, heartbeat_at)
       VALUES (@id, @episode_id, @episode_title, @world_name, @model, @status, 0,
               @total_ticks, @started_at, @owner_pid, @owner_host, @heartbeat_at)`,
    )
    .run({
      id: input.id,
      episode_id: input.episodeId,
      episode_title: input.episodeTitle,
      world_name: input.worldName ?? "",
      model: input.model,
      status: input.status ?? "queued",
      total_ticks: input.totalTicks,
      started_at: startedAt,
      owner_pid: input.owner?.pid ?? null,
      owner_host: input.owner?.host ?? null,
      // The first beat is the moment of creation: a process that dies between
      // the insert and its first timer tick has still been silent since here.
      heartbeat_at: input.owner ? Date.now() : null,
    });
  const run = getRun(input.id);
  if (!run) throw new Error(`run ${input.id} vanished immediately after being created`);
  return run;
}

/**
 * Per-tick heartbeat. Only the fields given are written, so the engine can push
 * a clock tick without clobbering the last event, and vice versa.
 */
export function updateRunProgress(
  id: string,
  patch: {
    status?: RunStatus;
    tick?: number;
    simTime?: string;
    lastEvent?: string;
    costUsd?: number;
  },
): void {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.status !== undefined) (sets.push("status = ?"), values.push(patch.status));
  if (patch.tick !== undefined) (sets.push("tick = ?"), values.push(patch.tick));
  if (patch.simTime !== undefined) (sets.push("sim_time = ?"), values.push(patch.simTime));
  if (patch.lastEvent !== undefined) (sets.push("last_event = ?"), values.push(patch.lastEvent));
  if (patch.costUsd !== undefined) (sets.push("cost_usd = ?"), values.push(patch.costUsd));
  if (sets.length === 0) return;
  // Progress is proof of life, so it beats too — a run that ticks cannot be
  // reconciled away between two beats of the timer.
  sets.push("heartbeat_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

/** Terminal write: the verdict plus the whole `EpisodeRun` artifact. */
export function finishRun(input: {
  id: string;
  status: RunStatus;
  outcome?: VerdictOutcome;
  score?: number;
  autonomy?: number;
  costUsd?: number;
  error?: string;
  runJson?: unknown;
  endedAt?: number;
}): void {
  getDb()
    .prepare(
      // Ownership is dropped with the same write that ends the run: a terminal
      // row has nobody driving it, and a stale pid left behind is one process
      // restart away from being somebody else's.
      `UPDATE runs SET status = @status, outcome = @outcome, score = @score, autonomy = @autonomy,
              cost_usd = COALESCE(@cost_usd, cost_usd), error = @error,
              run_json = COALESCE(@run_json, run_json), ended_at = @ended_at,
              owner_pid = NULL, owner_host = NULL, heartbeat_at = NULL
       WHERE id = @id`,
    )
    .run({
      id: input.id,
      status: input.status,
      outcome: input.outcome ?? null,
      score: input.score ?? null,
      autonomy: input.autonomy ?? null,
      cost_usd: input.costUsd ?? null,
      error: input.error ?? null,
      run_json: input.runJson === undefined ? null : JSON.stringify(input.runJson),
      ended_at: input.endedAt ?? Date.now(),
    });
}

export function getRun(id: string): RunSummary | null {
  const row = getDb().prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as
    | RunRow
    | undefined;
  return row ? toRun(row) : null;
}

/** The saved `EpisodeRun`, or null while the run is still going. */
export function getRunArtifact(id: string): unknown {
  const row = getDb().prepare("SELECT run_json FROM runs WHERE id = ?").get(id) as
    | { run_json: string | null }
    | undefined;
  return row?.run_json ? (JSON.parse(row.run_json) as unknown) : null;
}

export function listRuns(options: { limit?: number; episodeId?: string } = {}): RunSummary[] {
  const limit = options.limit ?? 50;
  const db = getDb();
  const rows = (
    options.episodeId
      ? db
          .prepare(
            `SELECT ${RUN_COLUMNS} FROM runs WHERE episode_id = ? ORDER BY started_at DESC LIMIT ?`,
          )
          .all(options.episodeId, limit)
      : db
          .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY started_at DESC LIMIT ?`)
          .all(limit)
  ) as RunRow[];
  return rows.map(toRun);
}

/** Anything still moving — queued, running or being judged. */
export const LIVE_STATUSES: readonly RunStatus[] = ["queued", "running", "judging"];

// ---------------------------------------------------------------------------
// Liveness. Who is driving a run, and how anyone else can tell.
// ---------------------------------------------------------------------------

// A ROW THAT SAYS "running" IS A CLAIM, AND A CLAIM NEEDS A CLAIMANT.
//
// This table is written by more than one process: the dashboard drives runs
// started from the Start button, `sonata run` drives its own from a terminal,
// and the benchmark runner drives a matrix of them. So a process CANNOT decide a
// run is dead because it is not the one driving it — that reasoning would have
// the web server declare a live CLI run finished the moment someone opened Home.
//
// Ownership is therefore recorded rather than inferred. Whoever drives a run
// stamps its pid and host on the row and re-stamps `heartbeat_at` as it goes; a
// run is interrupted when that mark goes cold. Two independent signals, either
// of which is enough:
//
//   - SILENCE. Nothing has beaten for `HEARTBEAT_STALE_MS`. Works across hosts
//     and across processes, and is the only signal available for a row written
//     before ownership existed (the clock then runs from `started_at`).
//   - A DEAD OWNER. The owner is on this host and its pid is gone. Cheap, exact
//     and immediate, so a crashed run does not have to serve out the silence.
//
// The one thing neither signal will do is call a run dead for being somebody
// else's, which is the whole point.

export interface RunOwner {
  pid: number;
  host: string;
}

/** This process, as the row records an owner. */
export function thisProcess(): RunOwner {
  return { pid: process.pid, host: hostname() };
}

/** How often a driving process should stamp `heartbeat_at`. */
export const HEARTBEAT_MS = 5_000;

/**
 * Silence longer than this and the run is treated as interrupted.
 *
 * Nine missed beats. Generous on purpose: a tick can be minutes of model calls,
 * and the cost of retiring a live run early — a day's spend thrown away — is far
 * higher than the cost of a stale row surviving another half minute.
 */
export const HEARTBEAT_STALE_MS = 45_000;

/**
 * The claim a process makes when it reconciles: "these are the runs I am
 * driving". Any row owned by this same process and absent from the set has lost
 * its driver — the registry that held it died with the last incarnation — so it
 * can be retired at once without waiting for the heartbeat to go cold.
 */
export interface DrivingClaim {
  owner: RunOwner;
  runIds: ReadonlySet<string>;
}

/** Does this pid still exist? Signal 0 tests, it does not kill. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process is there and belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The last moment anyone can show the run was being driven. */
function lastSeen(row: RunRow): number {
  return row.heartbeat_at ?? row.started_at;
}

function ownerGone(row: RunRow, now: number, driving?: DrivingClaim): boolean {
  const owner =
    row.owner_pid !== null && row.owner_host !== null
      ? { pid: row.owner_pid, host: row.owner_host }
      : null;

  if (owner && driving && owner.pid === driving.owner.pid && owner.host === driving.owner.host) {
    return !driving.runIds.has(row.id);
  }
  if (owner && owner.host === hostname() && !processAlive(owner.pid)) return true;
  return now - lastSeen(row) > HEARTBEAT_STALE_MS;
}

/** One line of it, short enough to sit inside a sentence. */
function oneLine(text: string, max = 160): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function atClock(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What an interrupted run says about itself.
 *
 * Its last known state and its last error, in words: the run did not finish, and
 * the reader's next question is always "how far did it get, and on what".
 */
function interruptionNote(row: RunRow): string {
  const parts = [
    `Interrupted. Nothing has been driving this run since ${atClock(lastSeen(row))}, when it was on tick ${row.tick} of ${row.total_ticks}.`,
  ];
  if (row.last_event) parts.push(`Last event: ${oneLine(row.last_event)}`);
  if (row.error) parts.push(`Last error: ${oneLine(row.error)}`);
  return parts.join(" ");
}

function liveRows(): RunRow[] {
  return getDb()
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ('queued','running','judging')
       ORDER BY started_at DESC`,
    )
    .all() as RunRow[];
}

/**
 * Retire every live-looking run whose owner has gone away.
 *
 * Ends them where they were last seen rather than now — a run interrupted at
 * 18:12 yesterday did not run for 23 hours, and the duration on the card is read
 * as measured. Returns the ids it retired.
 */
export function reconcileLiveRuns(driving?: DrivingClaim): string[] {
  const now = Date.now();
  const retired: string[] = [];
  for (const row of liveRows()) {
    if (!ownerGone(row, now, driving)) continue;
    finishRun({
      id: row.id,
      // There is no "interrupted" status to move to — a run stopped by something
      // other than itself is aborted, and the note says who stopped it. Terminal
      // either way, which is what stops the clock.
      status: "aborted",
      error: interruptionNote(row),
      endedAt: lastSeen(row),
    });
    retired.push(row.id);
  }
  return retired;
}

/** The same check for one run, on the path that reads it. Did it retire it? */
export function reconcileRun(id: string, driving?: DrivingClaim): boolean {
  const row = getDb().prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as
    | RunRow
    | undefined;
  if (!row || !LIVE_STATUSES.includes(row.status as RunStatus)) return false;
  if (!ownerGone(row, Date.now(), driving)) return false;
  finishRun({
    id: row.id,
    status: "aborted",
    error: interruptionNote(row),
    endedAt: lastSeen(row),
  });
  return true;
}

/** Take ownership of an existing row — a benchmark cell being re-run into its own id. */
export function claimRun(id: string, owner: RunOwner, at: number = Date.now()): void {
  getDb()
    .prepare("UPDATE runs SET owner_pid = ?, owner_host = ?, heartbeat_at = ? WHERE id = ?")
    .run(owner.pid, owner.host, at, id);
}

/**
 * "Still here." Ignored once the run is terminal, so a beat that lands after the
 * finishing write cannot resurrect a finished run.
 */
export function heartbeatRun(id: string, at: number = Date.now()): void {
  getDb()
    .prepare(
      `UPDATE runs SET heartbeat_at = ?
       WHERE id = ? AND ended_at IS NULL AND status IN ('queued','running','judging')`,
    )
    .run(at, id);
}

/**
 * Runs that are actually being driven.
 *
 * Reconciled first, every time. This is what Home and the sidebar count, so it
 * is the one read that must never answer with a run that nothing is running —
 * and the read is what finally retires a run nobody thought to look at.
 */
export function listLiveRuns(): RunSummary[] {
  reconcileLiveRuns();
  return liveRows().map(toRun);
}

export function countRuns(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

export interface RunStats {
  /** Runs that produced a result. The denominator for everything below. */
  scored: number;
  /** Runs that ended without one — errored, stopped, or the agent never acted. */
  unscored: number;
  /** Fraction of scored runs whose outcome was `pass`, 0..1; null if none. */
  passRate: number | null;
  /** Mean autonomy across scored runs, 0..1; null if none scored. */
  autonomy: number | null;
  spendUsd: number;
}

/**
 * The headline numbers, over the runs that have one.
 *
 * A run with a null score is a run we know nothing about — it crashed, was
 * stopped, or the agent never touched a twin — and it is counted separately
 * rather than folded in. Averaging those in as zeroes is exactly how four runs
 * that never started came to sit mid-table beside a run with 45 real actions.
 */
export function runStats(): RunStats {
  const row = getDb()
    .prepare(
      `SELECT SUM(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
              SUM(CASE WHEN score IS NULL AND status IN ('done','failed','aborted')
                       THEN 1 ELSE 0 END) AS unscored,
              SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passed,
              AVG(autonomy) AS autonomy
       FROM runs`,
    )
    .get() as {
    scored: number | null;
    unscored: number | null;
    passed: number | null;
    autonomy: number | null;
  };
  // Spend counts every run, including the ones that fell over — a burnt run
  // still costs money, and hiding it would make the figure a lie.
  const spend = getDb().prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs").get() as {
    usd: number;
  };
  const scored = row.scored ?? 0;
  return {
    scored,
    unscored: row.unscored ?? 0,
    passRate: scored > 0 ? (row.passed ?? 0) / scored : null,
    autonomy: row.autonomy,
    spendUsd: spend.usd,
  };
}

// ---------------------------------------------------------------------------
// Settings (key/value). Typed accessors live in ./settings.
// ---------------------------------------------------------------------------

export function readSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function readSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ---------------------------------------------------------------------------
// Twin processes. Written by ./twins; here because the connection lives here.
// ---------------------------------------------------------------------------

export interface TwinProcessRow {
  twin: TwinName;
  pid: number;
  port: number;
  startedAt: number;
  logPath: string;
}

export function readTwinProcess(twin: TwinName): TwinProcessRow | null {
  const row = getDb()
    .prepare("SELECT twin, pid, port, started_at, log_path FROM twin_processes WHERE twin = ?")
    .get(twin) as
    | { twin: string; pid: number; port: number; started_at: number; log_path: string }
    | undefined;
  return row
    ? {
        twin: row.twin as TwinName,
        pid: row.pid,
        port: row.port,
        startedAt: row.started_at,
        logPath: row.log_path,
      }
    : null;
}

export function writeTwinProcess(row: TwinProcessRow): void {
  getDb()
    .prepare(
      `INSERT INTO twin_processes (twin, pid, port, started_at, log_path)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(twin) DO UPDATE SET pid = excluded.pid, port = excluded.port,
              started_at = excluded.started_at, log_path = excluded.log_path`,
    )
    .run(row.twin, row.pid, row.port, row.startedAt, row.logPath);
}

export function clearTwinProcess(twin: TwinName): void {
  getDb().prepare("DELETE FROM twin_processes WHERE twin = ?").run(twin);
}
