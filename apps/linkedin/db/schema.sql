-- LinkedIn Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (every statement is guarded so
-- this file is safe to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- LinkedIn data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,               -- bare person id; the URN is urn:li:person:<id>
  email       TEXT NOT NULL,                  -- the join key to the other clones' cast
  given_name  TEXT NOT NULL,
  family_name TEXT NOT NULL,
  headline    TEXT,
  vanity_name TEXT,                           -- the /in/ slug
  picture_url TEXT,
  locale      TEXT NOT NULL DEFAULT 'en-US',
  is_owner    INTEGER NOT NULL DEFAULT 0      -- the member /v2/userinfo answers as
);
-- Lowercased so a seed cannot create a second Priya under a different casing;
-- the same address must always be the same person across all four clones.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email ON members (lower(email));

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,               -- bare numeric id; urn:li:organization:<id>
  name        TEXT NOT NULL,
  vanity_name TEXT
);

-- Backs GET /rest/organizationAcls and, more importantly, the 403 on
-- POST /rest/posts: authoring as a page you do not administer has to fail the
-- way it fails at LinkedIn, or an agent learns a permission model that does not
-- exist.
CREATE TABLE IF NOT EXISTS organization_acls (
  organization_id TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'ADMINISTRATOR',
  state           TEXT NOT NULL DEFAULT 'APPROVED',   -- APPROVED | REQUESTED | REJECTED | REVOKED
  PRIMARY KEY (organization_id, member_id, role),
  FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS posts (
  id                  TEXT PRIMARY KEY,       -- 19-digit share id; TEXT because it overflows a JS number
  author_urn          TEXT NOT NULL,          -- urn:li:person:<id> or urn:li:organization:<id>
  commentary          TEXT NOT NULL,
  visibility          TEXT NOT NULL DEFAULT 'PUBLIC',      -- PUBLIC | CONNECTIONS | LOGGED_IN
  feed_distribution   TEXT NOT NULL DEFAULT 'MAIN_FEED',   -- MAIN_FEED | NONE
  lifecycle_state     TEXT NOT NULL DEFAULT 'PUBLISHED',   -- PUBLISHED | DRAFT
  is_edited           INTEGER NOT NULL DEFAULT 0,          -- lifecycleStateInfo.isEditedByAuthor
  is_reshare_disabled INTEGER NOT NULL DEFAULT 0,
  comments_state      TEXT NOT NULL DEFAULT 'OPEN',        -- OPEN | CLOSED
  created_ms          INTEGER NOT NULL,       -- epoch ms
  published_ms        INTEGER,                -- epoch ms; NULL while DRAFT, which is what makes
                                              -- DRAFT -> PUBLISHED a transition and not a flag flip
  last_modified_ms    INTEGER NOT NULL,       -- epoch ms
  deleted_ms          INTEGER,                -- tombstone; the row outlives the API resource so the
                                              -- judge can still see what the agent destroyed
  raw_json            TEXT,                   -- passthrough (content, contentCallToActionLabel, ...)
  is_sandbox_created  INTEGER NOT NULL DEFAULT 0
);
-- The author finder is the hot read, and its sortBy picks between exactly these
-- two orderings, so both are indexed and neither is speculative.
CREATE INDEX IF NOT EXISTS idx_posts_author_modified ON posts (author_urn, last_modified_ms DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts (author_urn, created_ms DESC);

CREATE TABLE IF NOT EXISTS comments (
  id                 TEXT PRIMARY KEY,        -- 19-digit comment id
  post_id            TEXT NOT NULL,
  parent_comment_id  TEXT,                    -- one level of replies is all socialActions needs
  actor_urn          TEXT NOT NULL,           -- person or organization URN
  agent_urn          TEXT,                    -- the admin who acted, when actor_urn is a page
  message_text       TEXT NOT NULL,
  attributes_json    TEXT,                    -- mention annotations, verbatim; never rendered
  created_ms         INTEGER NOT NULL,
  last_modified_ms   INTEGER NOT NULL,
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES comments (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_ms);

-- No foreign key on purpose: entity_urn names either a post or a comment, so
-- there is no one table to point at. urn.ts canonicalises a post to its activity
-- form on the way in, and that is what keeps the two ends agreeing.
CREATE TABLE IF NOT EXISTS reactions (
  actor_urn          TEXT NOT NULL,
  entity_urn         TEXT NOT NULL,           -- a post is always stored as its urn:li:activity: form
  reaction_type      TEXT NOT NULL,           -- LIKE|PRAISE|EMPATHY|INTEREST|APPRECIATION|ENTERTAINMENT
  created_ms         INTEGER NOT NULL,
  last_modified_ms   INTEGER NOT NULL,
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_urn, entity_urn)         -- one reaction per actor per entity, as at LinkedIn
);
CREATE INDEX IF NOT EXISTS idx_reactions_entity ON reactions (entity_urn);

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
  method        TEXT NOT NULL,               -- HTTP method
  endpoint      TEXT NOT NULL,               -- request path
  action_type   TEXT,                        -- postCreate|postUpdate|postPublish|postDelete|
                                             -- commentCreate|reactionCreate
  target_type   TEXT,                        -- 'post' | 'comment'
  target_id     TEXT,                        -- the full URN, so a summary line resolves without a join
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
