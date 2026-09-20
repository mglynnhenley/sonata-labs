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

// Every accessor below has a safe default so an unseeded database answers rather
// than throwing: /api/health has to report on an empty clone, and a route that
// 500s on a missing meta row is indistinguishable from a broken twin.

/** The member /v2/userinfo answers as. */
export function getOwnerPersonId(db: Database): string {
  return getMeta(db, "owner_person_id") || "sandboxowner";
}

/** Nullable on purpose: a cloned world may have no company page at all. */
export function getOrganizationId(db: Database): string | null {
  return getMeta(db, "organization_id");
}
