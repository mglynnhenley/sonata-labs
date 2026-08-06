-- Sonata's own state. The nine twin databases are not here and never will be:
-- see src/lib/pg.ts.
--
-- Every timestamp is an epoch in milliseconds, as BIGINT, rather than
-- TIMESTAMPTZ. The whole app types them `number` and does arithmetic on them
-- (`Date.now() - startedAt`), the engine's tick clock is milliseconds, and the
-- values crossing to the browser are milliseconds — converting at the database
-- edge would mean converting back everywhere above it for no reader's benefit.
--
-- The big JSON columns are TEXT, not JSONB. A WorldSeed, an EpisodeSpec and an
-- EpisodeRun are @sonata/core artifacts read whole or not at all; JSONB would
-- reorder their keys and normalise their numbers, which is the wrong thing to do
-- to a file whose point is to be re-judgeable months later, byte for byte.

CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT   NOT NULL,
  description   TEXT   NOT NULL,
  industry      TEXT   NOT NULL DEFAULT '',
  prompt        TEXT   NOT NULL DEFAULT '',
  cast_size     INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER NOT NULL DEFAULT 0,
  seed_json     TEXT   NOT NULL,
  created_at    BIGINT NOT NULL,
  seeded_at     BIGINT
);

CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  world_id    TEXT   NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title       TEXT   NOT NULL,
  story       TEXT   NOT NULL,
  template_id TEXT,
  twins       TEXT   NOT NULL,
  ticks       INTEGER NOT NULL,
  spec_json   TEXT   NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_world ON episodes (world_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT   NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  episode_title TEXT   NOT NULL,
  world_name    TEXT   NOT NULL DEFAULT '',
  model         TEXT   NOT NULL,
  status        TEXT   NOT NULL,
  tick          INTEGER NOT NULL DEFAULT 0,
  total_ticks   INTEGER NOT NULL,
  sim_time      TEXT,
  last_event    TEXT,
  outcome       TEXT,
  score         DOUBLE PRECISION,
  autonomy      DOUBLE PRECISION,
  cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at    BIGINT NOT NULL,
  ended_at      BIGINT,
  error         TEXT,
  run_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT   NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Twin child processes the dashboard started. A pid in the database (rather than
-- only in memory) is what lets a dev-server reload re-adopt a running twin
-- instead of orphaning it on a port it will then refuse to rebind.
CREATE TABLE IF NOT EXISTS twin_processes (
  twin       TEXT PRIMARY KEY,
  pid        INTEGER NOT NULL,
  port       INTEGER NOT NULL,
  started_at BIGINT  NOT NULL,
  log_path   TEXT    NOT NULL
);

-- Sessions get their own tables rather than the `runs` table a run uses. A
-- session is not a run until it has finished: putting it in `runs` would put it
-- in Home's live list and the runs index, both of which link to /runs/<id> — a
-- page that reads a document store this never writes. It joins the shared record
-- at the end, as an artifact, which is the only place the two kinds belong side
-- by side.
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  episode_id           TEXT NOT NULL,
  title                TEXT NOT NULL,
  agent_label          TEXT NOT NULL,
  model                TEXT NOT NULL,
  status               TEXT NOT NULL,
  twins                TEXT NOT NULL,
  compression          DOUBLE PRECISION NOT NULL,
  sim_minutes_per_tick INTEGER NOT NULL,
  real_ms_per_tick     INTEGER NOT NULL,
  tick                 INTEGER NOT NULL DEFAULT 0,
  total_ticks          INTEGER NOT NULL,
  sim_time             TEXT,
  last_event           TEXT,
  beats                INTEGER NOT NULL DEFAULT 0,
  director_events      INTEGER NOT NULL DEFAULT 0,
  agent_actions        INTEGER NOT NULL DEFAULT 0,
  last_agent_at        BIGINT,
  idle_streak          INTEGER NOT NULL DEFAULT 0,
  longest_idle_streak  INTEGER NOT NULL DEFAULT 0,
  outcome              TEXT,
  score                DOUBLE PRECISION,
  autonomy             DOUBLE PRECISION,
  cost_usd             DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at           BIGINT NOT NULL,
  ended_at             BIGINT,
  ended_because        TEXT,
  no_result            TEXT,
  caveats              TEXT,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at DESC);

-- Ticks as they land, not only at the end. The registry holds the day in memory,
-- and a process that dies takes the memory with it; a session runs for minutes
-- or hours, so this is the difference between a restart costing a refresh and
-- costing the whole morning.
CREATE TABLE IF NOT EXISTS session_ticks (
  session_id TEXT    NOT NULL,
  tick       INTEGER NOT NULL,
  json       TEXT    NOT NULL,
  PRIMARY KEY (session_id, tick)
);

-- The artifacts a user owns — the businesses they cloned, the scenarios they
-- saved, and their runs. All JSON documents by nature, so one document table
-- rather than four relational ones that would only ever be SELECT *'d.
CREATE TABLE IF NOT EXISTS sonata_docs (
  kind       TEXT   NOT NULL,
  id         TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  json       TEXT   NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_sonata_docs_kind_created ON sonata_docs (kind, created_at DESC);
