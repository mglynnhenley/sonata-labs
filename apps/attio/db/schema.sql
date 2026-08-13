-- Attio Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (every statement is guarded so
-- this file is safe to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- CRM data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Actors. Every created_by_actor, every deal owner and every task assignee
-- resolves to a row here, which is what stops a write inventing an identity.
CREATE TABLE IF NOT EXISTS workspace_members (
  id            TEXT PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email_address TEXT NOT NULL,
  access_level  TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'member' | 'suspended'
  avatar_url    TEXT,
  created_at_ms INTEGER NOT NULL                -- epoch ms
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email
  ON workspace_members (email_address COLLATE NOCASE);

-- The object registry. `{object}` in a path is an api_slug OR an object_id, so
-- resolution needs a table; singular_noun is what web_url interpolates
-- (/acme/person/<id>), which is the detail that makes a record URL look real.
-- There is no plural_noun: this clone mounts no objects endpoint, so nothing
-- would ever read it back, and a column only the seeders fill is a column that
-- can quietly disagree with the api_slug beside it.
CREATE TABLE IF NOT EXISTS objects (
  id            TEXT PRIMARY KEY,
  api_slug      TEXT NOT NULL,
  singular_noun TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  pos           INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_objects_slug ON objects (api_slug);

-- `type` drives both the writer and the shaper — it is the switch every value
-- passes through, so the vocabulary is closed to what both of them implement:
-- 'text' | 'personal-name' | 'email-address' | 'domain' | 'record-reference' |
-- 'status' | 'currency' | 'actor-reference'.
CREATE TABLE IF NOT EXISTS attributes (
  id             TEXT PRIMARY KEY,
  object_id      TEXT NOT NULL,
  api_slug       TEXT NOT NULL,
  title          TEXT NOT NULL,
  type           TEXT NOT NULL,
  is_multiselect INTEGER NOT NULL DEFAULT 0,
  currency_code  TEXT,                          -- ISO 4217; only for type = 'currency'
  pos            INTEGER NOT NULL DEFAULT 0,
  created_at_ms  INTEGER NOT NULL,
  FOREIGN KEY (object_id) REFERENCES objects (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attributes_object_slug
  ON attributes (object_id, api_slug);

-- A deal stage is a fixed option list, and Attio refuses a write naming a title
-- that is not in it rather than creating one. A table (not a JSON blob on
-- `attributes`) so a filter on a status title compiles to real SQL, and so the
-- 400 can name the allowed set.
CREATE TABLE IF NOT EXISTS statuses (
  id                    TEXT PRIMARY KEY,
  attribute_id          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  is_archived           INTEGER NOT NULL DEFAULT 0,
  celebration_enabled   INTEGER NOT NULL DEFAULT 0,
  target_time_in_status TEXT,                   -- ISO 8601 duration, or NULL
  pos                   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (attribute_id) REFERENCES attributes (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_statuses_attribute ON statuses (attribute_id, pos);

-- The record itself carries almost nothing — in Attio a record IS its bag of
-- values. Nothing here marks a row as agent-made or harness-made either: the
-- audit log is the one place that distinction lives, because /v2/* writes are
-- logged and /api/sandbox/* writes are not, and a second copy of it inside the
-- CRM tables would be a second thing the judge could read and disbelieve.
CREATE TABLE IF NOT EXISTS records (
  id                 TEXT PRIMARY KEY,
  object_id          TEXT NOT NULL,
  created_at_ms      INTEGER NOT NULL,          -- epoch ms
  FOREIGN KEY (object_id) REFERENCES objects (id) ON DELETE CASCADE
);

-- Every records/query is a scan of one object ordered by created_at.
CREATE INDEX IF NOT EXISTS idx_records_object_created ON records (object_id, created_at_ms);

-- The heart of the clone. Every value is a versioned row, never an update in
-- place: moving a deal stage closes the old row and inserts a new one, which is
-- what makes the active_from/active_until pair honest rather than decorative.
-- The typed columns are the SOURCE OF TRUTH for everything filterable, because
-- the filter compiler only ever touches columns; extra_json carries the type
-- parts no filter reaches. Fields Attio infers on read (email_domain,
-- root_domain, full_name) are computed at shape time and deliberately NOT
-- stored — a stored copy would drift from text_value.
CREATE TABLE IF NOT EXISTS attribute_values (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id          TEXT NOT NULL,
  attribute_id       TEXT NOT NULL,
  active_from_ms     INTEGER NOT NULL,          -- epoch ms
  active_until_ms    INTEGER,                   -- epoch ms; NULL while this is the current value
  actor_type         TEXT NOT NULL DEFAULT 'workspace-member', -- 'workspace-member' | 'api-token'
  actor_id           TEXT,
  text_value         TEXT,                      -- text, full_name, email address, domain
  number_value       REAL,                      -- currency amount
  ref_object         TEXT,                      -- record-reference target object slug, or an actor-reference's actor type
  ref_record_id      TEXT,                      -- record-reference target record, or an actor-reference's actor id
  status_id          TEXT,
  extra_json         TEXT,                      -- the type parts no filter reaches
  pos                INTEGER NOT NULL DEFAULT 0, -- multiselect order
  FOREIGN KEY (record_id) REFERENCES records (id) ON DELETE CASCADE,
  FOREIGN KEY (attribute_id) REFERENCES attributes (id) ON DELETE CASCADE
);

-- The hot read: the currently-active values for a page of records.
CREATE INDEX IF NOT EXISTS idx_values_record_active
  ON attribute_values (record_id, attribute_id, active_until_ms);

-- Both rendered forms are stored rather than derived on read: the derivation is
-- lossy in one direction (markdown → plaintext), and re-running it per request
-- would let a note's plaintext change under an agent that already read it.
CREATE TABLE IF NOT EXISTS notes (
  id                    TEXT PRIMARY KEY,
  parent_object         TEXT NOT NULL,          -- the object's api_slug
  parent_record_id      TEXT NOT NULL,
  title                 TEXT NOT NULL,
  content_plaintext     TEXT NOT NULL,
  content_markdown      TEXT NOT NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'workspace-member',
  created_by_actor_id   TEXT,
  created_at_ms         INTEGER NOT NULL        -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_notes_parent
  ON notes (parent_object, parent_record_id, created_at_ms DESC);

-- deadline_at is TEXT, not epoch ms, on purpose: Attio echoes back a deadline
-- exactly as it was sent (a bare "2026-07-31" stays a bare date), so the only
-- lossless thing to do is store the caller's string.
CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  content_plaintext     TEXT NOT NULL,
  deadline_at           TEXT,
  is_completed          INTEGER NOT NULL DEFAULT 0,
  completed_at_ms       INTEGER,                -- epoch ms; set when is_completed flips to 1
  created_by_actor_type TEXT NOT NULL DEFAULT 'workspace-member',
  created_by_actor_id   TEXT,
  created_at_ms         INTEGER NOT NULL        -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at_ms);

-- "What is outstanding on this deal" is an indexed lookup, not a JSON scan.
CREATE TABLE IF NOT EXISTS task_linked_records (
  task_id          TEXT NOT NULL,
  target_object    TEXT NOT NULL,               -- the object's api_slug
  target_record_id TEXT NOT NULL,
  pos              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, target_object, target_record_id),
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_links_record
  ON task_linked_records (target_object, target_record_id);

-- A task can carry more than one assignee and ?assignee= filters on it, so it
-- cannot be a column on `tasks`.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id    TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'workspace-member',
  actor_id   TEXT NOT NULL,
  pos        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, actor_id),
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Audit trail (audit.db) — separate file so it survives working.db resets.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,                  -- epoch ms
  note       TEXT
);

CREATE TABLE IF NOT EXISTS action_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,               -- epoch ms
  method        TEXT NOT NULL,                  -- HTTP method
  endpoint      TEXT NOT NULL,                  -- request path
  action_type   TEXT,                           -- 'recordCreate' | 'recordUpdate' | 'noteCreate' | 'taskCreate' | 'taskUpdate'
  target_type   TEXT,                           -- 'record' | 'note' | 'task'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                            -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
