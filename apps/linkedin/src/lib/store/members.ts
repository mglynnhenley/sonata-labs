import type { Database } from "better-sqlite3";
import type { MemberRow } from "../linkedin/shape";
import { getOwnerPersonId } from "./meta";

// The cast as LinkedIn sees them. `email` is the join key that makes this the
// same Priya as the one in the inbox and on the invite — nothing else in the row
// is shared with the other clones.

export interface MemberInput {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  pictureUrl?: string | null;
  locale?: string;
  isOwner?: boolean;
}

export function insertMember(db: Database, input: MemberInput): MemberRow {
  db.prepare(
    `INSERT INTO members (id, email, given_name, family_name, picture_url, locale, is_owner)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       given_name = excluded.given_name,
       family_name = excluded.family_name,
       picture_url = excluded.picture_url,
       locale = excluded.locale,
       is_owner = excluded.is_owner`,
  ).run(
    input.id,
    input.email,
    input.givenName,
    input.familyName,
    input.pictureUrl ?? null,
    input.locale ?? "en-US",
    input.isOwner ? 1 : 0,
  );
  const row = getMemberById(db, input.id);
  if (!row) throw new Error(`member ${input.id} vanished after insert`);
  return row;
}

export function getMemberById(db: Database, id: string): MemberRow | null {
  return (db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberRow) ?? null;
}

/** Lowercased lookup, through the unique index that keeps one email one person. */
export function getMemberByEmail(db: Database, email: string): MemberRow | null {
  return (
    (db
      .prepare("SELECT * FROM members WHERE lower(email) = lower(?)")
      .get(email) as MemberRow) ?? null
  );
}

/**
 * The authenticated member. Falls back to the meta owner_person_id because a
 * seed that forgot the flag should still answer /v2/userinfo with the right
 * person rather than with nobody.
 */
export function getOwnerMember(db: Database): MemberRow | null {
  const flagged = db.prepare("SELECT * FROM members WHERE is_owner = 1 LIMIT 1").get() as
    | MemberRow
    | undefined;
  return flagged ?? getMemberById(db, getOwnerPersonId(db));
}

export function countMembers(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM members").get() as { n: number }).n;
}
