-- Google Docs Sandbox Clone — audit schema (audit.db only)
--
-- Separate from db/schema.sql because these two tables belong to exactly one of
-- the three databases. Applied to snapshot.db and working.db as well, they would
-- sit there permanently empty and shadow the ATTACHed `audit.*` ones — and the
-- day a logAction lost its `audit.` prefix it would write to working.db instead
-- and the trail would vanish on the next reset, with every statement still
-- succeeding. The names exist in one place so that cannot be an accident.
--
-- Mirrored, prefixed with the ATTACH alias, as `AUDIT_DDL` in src/lib/db.ts:
-- CREATE TABLE names a schema, so the working connection needs its own spelling.
-- Change one and change the other; nothing catches the drift.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,               -- epoch ms
  note       TEXT
);

CREATE TABLE IF NOT EXISTS action_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,            -- epoch ms
  method        TEXT NOT NULL,              -- HTTP method
  endpoint      TEXT NOT NULL,              -- request path
  action_type   TEXT,                       -- 'documentCreate' | 'documentBatchUpdate'
  target_type   TEXT,                       -- 'document'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
