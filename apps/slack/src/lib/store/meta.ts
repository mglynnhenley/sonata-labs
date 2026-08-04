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

// Workspace identity, recorded by seed/sync and served by auth.test.

export interface SelfIdentity {
  teamId: string;
  teamName: string;
  teamDomain: string;
  userId: string;
  userName: string;
}

export function getSelf(db: Database): SelfIdentity {
  return {
    teamId: getMeta(db, "team_id") || "T00000000",
    teamName: getMeta(db, "team_name") || "Sandbox",
    teamDomain: getMeta(db, "team_domain") || "sandbox",
    userId: getMeta(db, "self_user_id") || "U00000000",
    userName: getMeta(db, "self_user_name") || "sandbox",
  };
}

export function setSelf(db: Database, self: SelfIdentity): void {
  setMeta(db, "team_id", self.teamId);
  setMeta(db, "team_name", self.teamName);
  setMeta(db, "team_domain", self.teamDomain);
  setMeta(db, "self_user_id", self.userId);
  setMeta(db, "self_user_name", self.userName);
}
