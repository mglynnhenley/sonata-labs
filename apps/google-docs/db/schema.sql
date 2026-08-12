-- Google Docs Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (every statement is
-- IF NOT EXISTS so this file is safe to apply wholesale to any of the three).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Document data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,          -- 44 url-safe chars, Google's shape
  title              TEXT NOT NULL,
  revision_id        TEXT NOT NULL,             -- opaque; changes on every applied batchUpdate
  owner_email        TEXT,
  created_ms         INTEGER NOT NULL,          -- epoch ms; internal only, the Document resource has no timestamps
  updated_ms         INTEGER NOT NULL,          -- epoch ms
  is_sandbox_created INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_ms DESC);

-- One row per body StructuralElement of kind `paragraph`, in order. The leading
-- sectionBreak is not stored: every document has exactly one and it is a constant.
CREATE TABLE IF NOT EXISTS paragraphs (
  document_id      TEXT NOT NULL,
  para_index       INTEGER NOT NULL,            -- 0-based position after the section break
  named_style_type TEXT NOT NULL DEFAULT 'NORMAL_TEXT',
  heading_id       TEXT,                        -- 'h.' + 12 chars, only on TITLE/SUBTITLE/HEADING_*
  alignment        TEXT,                        -- START|CENTER|END|JUSTIFIED, NULL when unset
  raw_json         TEXT,                        -- paragraphStyle fields echoed but not reasoned about
  FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

-- One row per ParagraphElement.textRun. A paragraph's text is the concatenation
-- of its runs and ALWAYS ends with exactly one \n — that newline is what the
-- paragraph's endIndex counts, and the whole index space depends on it.
CREATE TABLE IF NOT EXISTS text_runs (
  document_id TEXT NOT NULL,
  para_index  INTEGER NOT NULL,
  run_index   INTEGER NOT NULL,
  content     TEXT NOT NULL,
  style_json  TEXT,                             -- canonical TextStyle JSON; NULL means {}
  FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS named_ranges (
  id          TEXT PRIMARY KEY,                 -- 'kix.' + 12 chars
  document_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  start_index INTEGER NOT NULL,
  end_index   INTEGER NOT NULL,                 -- exclusive
  FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
);

-- Named UNIQUE indexes rather than composite PRIMARY KEYs: they enforce the same
-- uniqueness, and EXPLAIN QUERY PLAN reports them by name, which is what the
-- schema test asserts. Every read of a document is these two lookups.
CREATE UNIQUE INDEX IF NOT EXISTS idx_paragraphs_document ON paragraphs (document_id, para_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_text_runs_document ON text_runs (document_id, para_index, run_index);
CREATE INDEX IF NOT EXISTS idx_named_ranges_document ON named_ranges (document_id, start_index);

-- ---------------------------------------------------------------------------
-- Audit trail (audit.db) — separate file so it survives working.db resets.
-- ---------------------------------------------------------------------------

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
