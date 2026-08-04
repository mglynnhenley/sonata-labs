-- Calendar Sandbox Clone — schema (single source of truth)
-- Applied identically to snapshot.db and working.db. audit.db uses only the
-- `sessions` + `action_log` tables at the bottom (guarded so this file is safe
-- to apply wholesale to any of the three DBs).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Calendar data (snapshot.db / working.db)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS calendars (
  id          TEXT PRIMARY KEY,               -- email-shaped for the primary, opaque otherwise
  summary     TEXT NOT NULL,
  description TEXT,
  time_zone   TEXT NOT NULL DEFAULT 'UTC',    -- IANA zone; the default for events on it
  is_primary  INTEGER NOT NULL DEFAULT 0,
  access_role TEXT NOT NULL DEFAULT 'owner',  -- 'owner' | 'writer' | 'reader' | 'freeBusyReader'
  color_json  TEXT,                           -- JSON {colorId, backgroundColor, foregroundColor}
  raw_json    TEXT                            -- passthrough fields not modelled as columns
);

CREATE TABLE IF NOT EXISTS events (
  id                 TEXT PRIMARY KEY,        -- Calendar base32hex id (generated for sandbox-created)
  calendar_id        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'tentative' | 'cancelled'
  summary            TEXT,
  description        TEXT,
  location           TEXT,
  start_ms           INTEGER NOT NULL,        -- epoch ms; UTC midnight of the date for all-day
  end_ms             INTEGER NOT NULL,        -- epoch ms, exclusive
  all_day            INTEGER NOT NULL DEFAULT 0,
  start_tz           TEXT,                    -- IANA zone the start was authored in
  end_tz             TEXT,
  recurrence_json    TEXT,                    -- JSON array of RRULE/EXDATE/RDATE lines, verbatim
  organizer_email    TEXT,
  ical_uid           TEXT,
  created_ms         INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL,
  raw_json           TEXT NOT NULL,           -- resource JSON as authored (passthrough fields)
  is_sandbox_created INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (calendar_id) REFERENCES calendars (id) ON DELETE CASCADE
);

-- The one index that matters: every list/freeBusy read is a window scan on one
-- calendar ordered by start.
CREATE INDEX IF NOT EXISTS idx_events_calendar_start ON events (calendar_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events (updated_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_ical_uid ON events (ical_uid);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id        TEXT NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT,
  response_status TEXT NOT NULL DEFAULT 'needsAction', -- needsAction|declined|tentative|accepted
  optional        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, email),
  FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_attendees_email ON event_attendees (email);

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
  action_type   TEXT,                       -- 'insert' | 'update' | 'patch' | 'delete' | ...
  target_type   TEXT,                       -- 'event' | 'calendar'
  target_id     TEXT,
  request_json  TEXT,
  response_code INTEGER,
  summary       TEXT                         -- human-readable one-liner
);

CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
