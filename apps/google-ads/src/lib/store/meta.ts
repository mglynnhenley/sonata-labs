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

/** Who the account belongs to. Only the control plane reads it. */
export function getOwnerEmail(db: Database): string {
  return getMeta(db, "owner_email") || "me@sandbox.local";
}

/**
 * The world clock. Every DURING literal resolves against this instant, so a
 * seeded world's LAST_7_DAYS report is the same number on every run — a report
 * that quietly followed the wall clock would return nothing the day after the
 * world was written. The Date.now() fallback exists only so an unseeded database
 * answers rather than throws, and this is the one place in the clone a read may
 * fall back to now; a write never may.
 */
export function getWorldNowMs(db: Database): number {
  const raw = Number(getMeta(db, "world_now_ms"));
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now();
}

export function setWorldNowMs(db: Database, ms: number): void {
  setMeta(db, "world_now_ms", String(ms));
}
