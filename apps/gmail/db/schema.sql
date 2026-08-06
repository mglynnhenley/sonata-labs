-- Gmail Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (guarded so this file is safe
-- to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Mailbox data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS labels (
  id                     TEXT PRIMARY KEY,   -- 'INBOX', 'Label_7', ...
  name                   TEXT NOT NULL UNIQUE,
  type                   TEXT NOT NULL DEFAULT 'user',   -- 'system' | 'user'
  message_list_visibility TEXT,             -- 'show' | 'hide' | NULL
  label_list_visibility   TEXT,             -- 'labelShow' | 'labelHide' | 'labelShowIfUnread' | NULL
  color_json             TEXT               -- JSON {textColor, backgroundColor} or NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,       -- Gmail 16-hex id (generated for sandbox-created)
  thread_id          TEXT NOT NULL,
  internal_date      INTEGER NOT NULL,       -- epoch ms
  history_id         INTEGER NOT NULL,
  size_estimate      INTEGER NOT NULL DEFAULT 0,
  snippet            TEXT NOT NULL DEFAULT '',
  subject            TEXT,
  from_addr          TEXT,
  to_addrs           TEXT,
  cc_addrs           TEXT,
  bcc_addrs          TEXT,
  rfc822_message_id  TEXT,                   -- RFC822 Message-ID header (for reply threading)
  in_reply_to        TEXT,                   -- In-Reply-To header
  has_attachment     INTEGER NOT NULL DEFAULT 0,
  body_text          TEXT,                   -- extracted plain text (feeds FTS)
  raw_json           TEXT NOT NULL,          -- format=full resource JSON, labelIds STRIPPED
  raw_rfc822         TEXT,                   -- sandbox-created messages only (enables format=raw)
  is_sandbox_created INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages (internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_history ON messages (history_id);
CREATE INDEX IF NOT EXISTS idx_messages_rfc822 ON messages (rfc822_message_id);

CREATE TABLE IF NOT EXISTS message_labels (
  message_id TEXT NOT NULL,
  label_id   TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_message_labels_label ON message_labels (label_id);

CREATE TABLE IF NOT EXISTS attachments (
  message_id    TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  data          BLOB,                        -- NULL if over the sync cap
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT PRIMARY KEY,               -- draft id (≠ message id, Gmail semantics)
  message_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  envelope_to TEXT,                          -- JSON array of recipient addresses
  raw_rfc822  TEXT,
  created_at  INTEGER NOT NULL               -- epoch ms
);

-- Full-text search over messages. message_id UNINDEXED so we can join back.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  message_id UNINDEXED,
  subject,
  from_addr,
  to_addrs,
  body,
  tokenize = 'unicode61'
);

-- ---------------------------------------------------------------------------
-- OAuth2 (snapshot.db / working.db) — the sandbox's authorization server.
--
-- Additive to the mailbox schema so a `reset` (which copies snapshot.db over
-- working.db) carries the registered clients along: the well-known dev client is
-- seeded into BOTH files at db:init, and re-seeded after every reset, so the UI
-- can always complete its flow. Access/refresh tokens are ephemeral and
-- re-mintable, so losing them on reset is fine (the harness re-acquires on 401).
-- No `users` table — the sandbox is single-persona; identity is getProfileEmail().
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_secret TEXT,                          -- NULL for public clients (none today; PKCE required regardless)
  name          TEXT NOT NULL,                 -- shown on the consent screen ("<name> wants access…")
  redirect_uris TEXT NOT NULL,                 -- JSON array; validated by EXACT match
  confidential  INTEGER NOT NULL DEFAULT 1,    -- 1 = has a secret used at the token endpoint
  created_at    INTEGER NOT NULL               -- epoch ms
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,         -- the exact URI the code was issued against
  scope                 TEXT NOT NULL,         -- space-delimited granted scopes
  code_challenge        TEXT NOT NULL,         -- PKCE (S256 required on every authorize)
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at            INTEGER NOT NULL,      -- epoch ms (~60s)
  used_at               INTEGER                -- epoch ms; set on first exchange → single-use
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_token             TEXT PRIMARY KEY,
  refresh_token            TEXT UNIQUE,        -- NULL when a grant issues no refresh token
  client_id                TEXT NOT NULL,
  scope                    TEXT NOT NULL,      -- space-delimited granted scopes
  access_token_expires_at  INTEGER NOT NULL,  -- epoch ms
  refresh_token_expires_at INTEGER,           -- epoch ms; NULL = non-expiring
  revoked_at               INTEGER,           -- epoch ms; set on revocation
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens (refresh_token);

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
  action_type   TEXT,                       -- 'send' | 'modify' | 'trash' | 'delete' | ...
  target_type   TEXT,                       -- 'message' | 'thread' | 'label' | 'draft'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
