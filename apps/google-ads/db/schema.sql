-- Google Ads Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (every statement is guarded so
-- this file is safe to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Google Ads data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- The advertiser account. `id` is TEXT because Google Ads ids are int64 and
-- every one of them crosses the wire as a JSON string — storing them as text
-- means no BigInt anywhere in the clone.
CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  descriptive_name TEXT NOT NULL,
  currency_code    TEXT NOT NULL DEFAULT 'USD',
  time_zone        TEXT NOT NULL DEFAULT 'America/New_York'   -- TODAY / LAST_7_DAYS are computed in this zone, so it is a column and not a constant
);

CREATE TABLE IF NOT EXISTS campaign_budgets (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL,
  name               TEXT NOT NULL,
  amount_micros      INTEGER NOT NULL,                        -- micros: the currency unit x 1_000_000
  delivery_method    TEXT NOT NULL DEFAULT 'STANDARD',        -- 'STANDARD' | 'ACCELERATED'
  period             TEXT NOT NULL DEFAULT 'DAILY',
  explicitly_shared  INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'ENABLED',         -- 'ENABLED' | 'REMOVED'
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,              -- what separates the agent's budget from the world's
  FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);

-- `status` carries REMOVED rather than the row being deleted, because a removed
-- campaign is still queryable in the real API — an agent that removes one and
-- then cannot find it would learn something false.
CREATE TABLE IF NOT EXISTS campaigns (
  id                       TEXT PRIMARY KEY,
  customer_id              TEXT NOT NULL,
  budget_id                TEXT,                              -- the implicit join that makes SELECT campaign.name, campaign_budget.amount_micros work
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'ENABLED',   -- 'ENABLED' | 'PAUSED' | 'REMOVED'
  advertising_channel_type TEXT NOT NULL DEFAULT 'SEARCH',
  bidding_strategy_type    TEXT NOT NULL DEFAULT 'TARGET_SPEND',
  start_date               TEXT NOT NULL,                     -- YYYY-MM-DD in the account's time zone
  end_date                 TEXT,                              -- YYYY-MM-DD in the account's time zone
  is_sandbox_created       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  FOREIGN KEY (budget_id) REFERENCES campaign_budgets (id) ON DELETE SET NULL
);

-- Read-only this phase, but it is the grain metrics are stored at, so it has to
-- exist — and it gives the agent the narrower diagnosis of which ad group
-- inside the overspending campaign is doing the spending.
CREATE TABLE IF NOT EXISTS ad_groups (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL,
  campaign_id        TEXT NOT NULL,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ENABLED',
  type               TEXT NOT NULL DEFAULT 'SEARCH_STANDARD',
  cpc_bid_micros     INTEGER,                                 -- micros: the currency unit x 1_000_000
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
);

-- The fact table every metric comes from, at one grain — (ad_group, date) — so
-- campaign and account totals are always a SUM of the same rows and can never
-- disagree with each other. `ctr` and `average_cpc` are deliberately NOT stored:
-- they are computed at read time from clicks/impressions and cost/clicks, which
-- is the only way they stay consistent after an injected beat.
CREATE TABLE IF NOT EXISTS daily_stats (
  customer_id       TEXT NOT NULL,
  campaign_id       TEXT NOT NULL,
  ad_group_id       TEXT NOT NULL,
  date              TEXT NOT NULL,                            -- YYYY-MM-DD in the account's time zone
  impressions       INTEGER NOT NULL DEFAULT 0,
  clicks            INTEGER NOT NULL DEFAULT 0,
  cost_micros       INTEGER NOT NULL DEFAULT 0,               -- micros: the currency unit x 1_000_000
  conversions       REAL NOT NULL DEFAULT 0,
  conversions_value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_group_id, date),
  FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups (id) ON DELETE CASCADE
);

-- Every report is a date-window scan, so this is the index EXPLAIN QUERY PLAN
-- must choose; tests/schema.test.ts asserts that it does.
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date, campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_customer ON campaigns (customer_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_groups_campaign ON ad_groups (campaign_id);

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
  action_type   TEXT,                        -- 'campaignUpdate' | 'campaignRemove' | 'budgetCreate' | 'budgetUpdate' | 'budgetRemove'
  target_type   TEXT,                        -- 'campaign' | 'campaignBudget'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
