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

/** The sandbox owner — `self: true` on every resource they appear in. */
export function getOwnerEmail(db: Database): string {
  return getMeta(db, "owner_email") || "me@sandbox.local";
}

/** Fallback zone for calendars and for floating times the caller sends. */
export function getDefaultTimeZone(db: Database): string {
  return getMeta(db, "default_time_zone") || "UTC";
}
