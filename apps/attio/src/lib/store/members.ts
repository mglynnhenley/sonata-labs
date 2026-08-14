import type { Database } from "better-sqlite3";
import type { MemberRow } from "../attio/shape";

// Small, but it is the table that stops the clone inventing an identity on a
// write: an assignee email or a deal owner that is not in here is a 400, never
// a new person.

export function listMembers(db: Database): MemberRow[] {
  return db
    .prepare("SELECT * FROM workspace_members ORDER BY created_at_ms, id")
    .all() as MemberRow[];
}

export function getMemberById(db: Database, id: string): MemberRow | null {
  return (
    (db.prepare("SELECT * FROM workspace_members WHERE id = ?").get(id) as MemberRow) ?? null
  );
}

export function getMemberByEmail(db: Database, email: string): MemberRow | null {
  return (
    (db
      .prepare("SELECT * FROM workspace_members WHERE email_address = ? COLLATE NOCASE")
      .get(email) as MemberRow) ?? null
  );
}

export interface MemberInput {
  id: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  accessLevel?: string;
  avatarUrl?: string | null;
  createdAtMs: number;
}

export function insertMember(db: Database, input: MemberInput): void {
  db.prepare(
    `INSERT INTO workspace_members
       (id, first_name, last_name, email_address, access_level, avatar_url, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.firstName,
    input.lastName,
    input.emailAddress,
    input.accessLevel ?? "admin",
    input.avatarUrl ?? null,
    input.createdAtMs,
  );
}
