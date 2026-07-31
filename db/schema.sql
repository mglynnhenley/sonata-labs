-- Slack Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (guarded so this file is safe
-- to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Workspace data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Team / workspace members and bots.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,   -- 'U0123ABCD', 'B0123ABCD' for bots
  team_id       TEXT,
  name          TEXT,               -- handle (no @), historically unique
  real_name     TEXT,
  display_name  TEXT,
  tz            TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_owner      INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,  -- epoch seconds
  profile_json  TEXT,                        -- image urls, title, status, etc.
  raw_json      TEXT NOT NULL                -- full users.info resource
);

-- Channels, DMs, private groups, multi-person DMs — one row per conversation.
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,   -- 'C...' channel, 'D...' im, 'G...' group/mpim
  name         TEXT,               -- NULL for DMs
  is_channel   INTEGER NOT NULL DEFAULT 0,
  is_group     INTEGER NOT NULL DEFAULT 0,
  is_im        INTEGER NOT NULL DEFAULT 0,
  is_mpim      INTEGER NOT NULL DEFAULT 0,
  is_private   INTEGER NOT NULL DEFAULT 0,
  is_archived  INTEGER NOT NULL DEFAULT 0,
  is_general   INTEGER NOT NULL DEFAULT 0,
  creator      TEXT,               -- user id
  created      INTEGER NOT NULL DEFAULT 0,   -- epoch seconds
  num_members  INTEGER NOT NULL DEFAULT 0,
  topic_json   TEXT,               -- JSON {value, creator, last_set}
  purpose_json TEXT,               -- JSON {value, creator, last_set}
  raw_json     TEXT NOT NULL       -- full conversations.info resource
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members (user_id);

-- Messages. A Slack message is identified by (channel, ts). `ts` doubles as the
-- ordering key and the client-visible message id ("1699999999.001200").
CREATE TABLE IF NOT EXISTS messages (
  channel_id         TEXT NOT NULL,
  ts                 TEXT NOT NULL,          -- "seconds.micros"
  thread_ts          TEXT,                   -- parent ts; equals ts for the root
  user               TEXT,                   -- author user id (NULL for some bots)
  bot_id             TEXT,                   -- set for bot / app messages
  subtype            TEXT,                   -- 'bot_message', 'channel_join', ...
  text               TEXT,                   -- rendered text (feeds FTS)
  edited_ts          TEXT,                   -- ts of last edit, or NULL
  edited_user        TEXT,
  reply_count        INTEGER NOT NULL DEFAULT 0,
  reply_users_count  INTEGER NOT NULL DEFAULT 0,
  latest_reply       TEXT,                   -- ts of newest reply in the thread
  has_files          INTEGER NOT NULL DEFAULT 0,
  blocks_json        TEXT,                   -- Block Kit payload, or NULL
  raw_json           TEXT NOT NULL,          -- full message resource
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages (channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user);

CREATE TABLE IF NOT EXISTS reactions (
  channel_id  TEXT NOT NULL,
  message_ts  TEXT NOT NULL,
  name        TEXT NOT NULL,        -- emoji short name, e.g. 'thumbsup'
  user_id     TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_ts, name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (channel_id, message_ts);

CREATE TABLE IF NOT EXISTS files (
  id                 TEXT PRIMARY KEY,       -- 'F...'
  user               TEXT,                   -- uploader
  name               TEXT,
  title              TEXT,
  mimetype           TEXT,
  filetype           TEXT,
  size               INTEGER NOT NULL DEFAULT 0,
  created            INTEGER NOT NULL DEFAULT 0,  -- epoch seconds
  url_private        TEXT,
  permalink          TEXT,
  data               BLOB,                   -- NULL if over the sync cap
  raw_json           TEXT NOT NULL,
  is_sandbox_created INTEGER NOT NULL DEFAULT 0
);

-- Which messages a file is shared into (a file can appear in several).
CREATE TABLE IF NOT EXISTS message_files (
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  file_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_ts, file_id)
);

CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files (file_id);

-- Read cursors. Slack tracks a per-(conversation, user) last-read ts; unread
-- and mention counts are DERIVED from it rather than stored, so they can never
-- drift from the messages table.
CREATE TABLE IF NOT EXISTS read_state (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  last_read       TEXT NOT NULL DEFAULT '0000000000.000000',
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  created_by TEXT,                            -- user id who pinned
  created    INTEGER NOT NULL DEFAULT 0,      -- epoch seconds
  PRIMARY KEY (channel_id, message_ts)
);

-- Sandbox-created outbound messages (chat.postMessage / chat.scheduleMessage).
CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  message_ts  TEXT NOT NULL,
  post_at     INTEGER,                        -- epoch seconds for scheduled, else NULL
  request_json TEXT,
  created_at  INTEGER NOT NULL                -- epoch ms
);

-- Full-text search over message text. channel_id + ts UNINDEXED so we can join
-- back to the messages row that owns each hit.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  channel_id UNINDEXED,
  ts UNINDEXED,
  user,
  text,
  tokenize = 'unicode61'
);

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
  endpoint      TEXT NOT NULL,              -- Web API method path, e.g. 'chat.postMessage'
  action_type   TEXT,                       -- 'post' | 'update' | 'delete' | 'react' | 'invite' | ...
  target_type   TEXT,                       -- 'message' | 'conversation' | 'user' | 'file'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
