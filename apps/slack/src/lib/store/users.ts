import type { Database } from "better-sqlite3";
import type { SlackUser, UserRow } from "../slack/types";

export interface InsertUserInput {
  id: string;
  teamId?: string | null;
  name?: string | null;
  realName?: string | null;
  displayName?: string | null;
  tz?: string | null;
  isBot?: boolean;
  isAdmin?: boolean;
  isOwner?: boolean;
  deleted?: boolean;
  updated?: number;
  profileJson?: string | null;
  rawJson: string;
}

export function insertUser(db: Database, u: InsertUserInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, team_id, name, real_name, display_name, tz, is_bot, is_admin, is_owner, deleted, updated, profile_json, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    u.id,
    u.teamId ?? null,
    u.name ?? null,
    u.realName ?? null,
    u.displayName ?? null,
    u.tz ?? null,
    u.isBot ? 1 : 0,
    u.isAdmin ? 1 : 0,
    u.isOwner ? 1 : 0,
    u.deleted ? 1 : 0,
    u.updated ?? 0,
    u.profileJson ?? null,
    u.rawJson,
  );
}

export function getUser(db: Database, id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserByName(db: Database, name: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE name = ? COLLATE NOCASE").get(name) as
    | UserRow
    | undefined;
}

/** Users ordered by id (Slack's users.list ordering is unspecified but stable). */
export function listUsers(db: Database, afterId: string | null, limit: number): UserRow[] {
  if (afterId) {
    return db
      .prepare("SELECT * FROM users WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit) as UserRow[];
  }
  return db.prepare("SELECT * FROM users ORDER BY id LIMIT ?").all(limit) as UserRow[];
}

export function countUsers(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

/** Shape a row into a users.info member resource: raw_json + live columns. */
export function shapeUser(row: UserRow): SlackUser {
  const base = JSON.parse(row.raw_json) as SlackUser;
  return {
    ...base,
    id: row.id,
    name: row.name ?? base.name,
    deleted: !!row.deleted,
    is_bot: !!row.is_bot,
    is_admin: !!row.is_admin,
    is_owner: !!row.is_owner,
    updated: row.updated || base.updated,
  };
}
