import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { EpisodeSpec, RunStatus, TwinName, WorldSeed } from "@sonata/core";

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
  run_json TEXT
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

type Db = Database.Database;

// Next's dev server re-evaluates modules on every edit; without the singleton
// each reload would leak a file handle.
const g = globalThis as unknown as { __sonataPlatformDb?: Db };

function open(): Db {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(PLATFORM_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Db {
  if (!g.__sonataPlatformDb) g.__sonataPlatformDb = open();
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
  outcome: "pass" | "partial" | "fail" | null;
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
}

const RUN_COLUMNS =
  "id, episode_id, episode_title, world_name, model, status, tick, total_ticks, sim_time, " +
  "last_event, outcome, score, autonomy, cost_usd, started_at, ended_at, error";

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
}): RunSummary {
  getDb()
    .prepare(
      `INSERT INTO runs (id, episode_id, episode_title, world_name, model, status, tick,
                         total_ticks, started_at)
       VALUES (@id, @episode_id, @episode_title, @world_name, @model, @status, 0,
               @total_ticks, @started_at)`,
    )
    .run({
      id: input.id,
      episode_id: input.episodeId,
      episode_title: input.episodeTitle,
      world_name: input.worldName ?? "",
      model: input.model,
      status: input.status ?? "queued",
      total_ticks: input.totalTicks,
      started_at: input.startedAt ?? Date.now(),
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
  values.push(id);
  getDb()
    .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

/** Terminal write: the verdict plus the whole `EpisodeRun` artifact. */
export function finishRun(input: {
  id: string;
  status: RunStatus;
  outcome?: "pass" | "partial" | "fail";
  score?: number;
  autonomy?: number;
  costUsd?: number;
  error?: string;
  runJson?: unknown;
  endedAt?: number;
}): void {
  getDb()
    .prepare(
      `UPDATE runs SET status = @status, outcome = @outcome, score = @score, autonomy = @autonomy,
              cost_usd = COALESCE(@cost_usd, cost_usd), error = @error,
              run_json = COALESCE(@run_json, run_json), ended_at = @ended_at
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

export function listLiveRuns(): RunSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status IN ('queued','running','judging')
       ORDER BY started_at DESC`,
    )
    .all() as RunRow[];
  return rows.map(toRun);
}

export function countRuns(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

export interface RunStats {
  finished: number;
  /** Fraction of finished runs whose outcome was `pass`, 0..1; null if none. */
  passRate: number | null;
  /** Mean autonomy across finished runs, 0..1; null if none scored. */
  autonomy: number | null;
  spendUsd: number;
}

export function runStats(): RunStats {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS finished,
              SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passed,
              AVG(autonomy) AS autonomy
       FROM runs WHERE status = 'done'`,
    )
    .get() as { finished: number; passed: number | null; autonomy: number | null };
  // Spend counts every run, including the ones that fell over — a burnt run
  // still costs money, and hiding it would make the figure a lie.
  const spend = getDb().prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs").get() as {
    usd: number;
  };
  return {
    finished: row.finished,
    passRate: row.finished > 0 ? (row.passed ?? 0) / row.finished : null,
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
