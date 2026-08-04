import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths. Everything lives under data/ (gitignored).
// ---------------------------------------------------------------------------

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.db");
export const WORKING_PATH = path.join(DATA_DIR, "working.db");
export const AUDIT_PATH = path.join(DATA_DIR, "audit.db");
export const SCHEMA_PATH = path.resolve(process.cwd(), "db", "schema.sql");

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

// audit.db DDL, addressable via the ATTACH alias `audit`. Kept in sync with the
// audit section of db/schema.sql. Applied against the working connection after
// ATTACH so the two tables always exist even on a brand-new file.
export const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit.sessions (
  id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS audit.action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  method TEXT NOT NULL, endpoint TEXT NOT NULL,
  action_type TEXT, target_type TEXT, target_id TEXT,
  request_json TEXT, response_code INTEGER, summary TEXT
);
CREATE INDEX IF NOT EXISTS audit.idx_action_log_session ON action_log (session_id, ts);
`;

// ---------------------------------------------------------------------------
// Singleton working connection (with audit.db ATTACHed). Stored on globalThis
// so Next.js HMR reuses one handle, and so the reset endpoint can close/reopen
// the connection every route handler shares.
// ---------------------------------------------------------------------------

type Db = Database.Database;

const g = globalThis as unknown as { __calendarSandboxWorking?: Db };

function openWorking(): Db {
  ensureDataDir();
  const db = new Database(WORKING_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // ATTACH audit.db so the mutation and its audit row commit atomically in one
  // transaction, while audit.db remains a separate file that survives resets.
  db.prepare("ATTACH DATABASE ? AS audit").run(AUDIT_PATH);
  db.pragma("audit.journal_mode = WAL");
  db.exec(AUDIT_DDL);
  return db;
}

/** The working calendar connection, with `audit` ATTACHed. */
export function getDb(): Db {
  if (!g.__calendarSandboxWorking) g.__calendarSandboxWorking = openWorking();
  return g.__calendarSandboxWorking;
}

/** Close the working connection (used by reset before swapping files). */
export function closeWorkingDb(): void {
  if (g.__calendarSandboxWorking) {
    g.__calendarSandboxWorking.close();
    g.__calendarSandboxWorking = undefined;
  }
}

/** Apply the full calendar schema to an already-open handle (snapshot/working). */
export function applySchema(db: Db): void {
  db.exec(readSchema());
}
