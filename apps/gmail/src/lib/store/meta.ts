import type { Database } from "better-sqlite3";

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getProfileEmail(db: Database): string {
  return getMeta(db, "profile_email") || "me@sandbox.local";
}

/**
 * Increment and return the global history counter. Gmail assigns a
 * monotonically increasing historyId to every change; every mutation calls
 * this inside its transaction. Starts at 1.
 */
export function nextHistoryId(db: Database): number {
  const current = Number(getMeta(db, "history_counter") || "0");
  const next = current + 1;
  setMeta(db, "history_counter", String(next));
  return next;
}

export function currentHistoryId(db: Database): number {
  return Number(getMeta(db, "history_counter") || "0");
}
