import type { Database } from "better-sqlite3";

// Owner identity and seed provenance, read through named accessors with safe
// defaults so an unseeded database answers instead of throwing.

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

/** The sandbox owner — the address every document this twin creates belongs to. */
export function getOwnerEmail(db: Database): string {
  return getMeta(db, "owner_email") || "me@sandbox.local";
}
