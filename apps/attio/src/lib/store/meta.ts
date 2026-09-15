import type { Database } from "better-sqlite3";

// The workspace's own identity. Every accessor has a safe default so an
// unseeded database still answers /api/health and /v2/self instead of throwing:
// a twin that 500s before it is seeded looks broken rather than empty.

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Version writes must follow the seeded history, even when its date is ahead
 * of the host clock. Include imported notes so a memo sorts after the transcript
 * it responds to, and tasks so completion cannot predate creation.
 * This is an ordering floor, not the episode's tick clock;
 * audit rows retain wall time so the harness can attribute actions to ticks.
 */
export function crmWriteTime(db: Database, wallNow = Date.now()): number {
  const latest = db.prepare(`SELECT MAX(at) AS at FROM (
    SELECT MAX(active_from_ms) AS at FROM attribute_values
    UNION ALL SELECT MAX(created_at_ms) FROM records
    UNION ALL SELECT MAX(created_at_ms) FROM notes
    UNION ALL SELECT MAX(created_at_ms) FROM tasks
    UNION ALL SELECT MAX(completed_at_ms) FROM tasks
  )`).get() as { at: number | null };
  const seeded = Number(getMeta(db, "seeded_at")) || 0;
  return Math.max(wallNow, seeded, latest.at === null ? 0 : latest.at + 1);
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Stamped into every id object the API returns, so it cannot live anywhere else. */
export function getWorkspaceId(db: Database): string {
  return getMeta(db, "workspace_id") || "00000000-0000-4000-8000-000000000000";
}

/** The slug in every record's web_url. */
export function getWorkspaceSlug(db: Database): string {
  return getMeta(db, "workspace_slug") || "sandbox";
}

export function getWorkspaceName(db: Database): string {
  return getMeta(db, "workspace_name") || "Sandbox Workspace";
}

/** `authorized_by_workspace_member_id` on /v2/self, and the seed's author. */
export function getOwnerMemberId(db: Database): string {
  return getMeta(db, "owner_member_id") || "";
}
