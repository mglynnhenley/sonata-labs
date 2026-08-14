import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_DDL } from "@/lib/db";
import { setMeta } from "@/lib/store/meta";
import { insertMember } from "@/lib/store/members";
import { insertRecord } from "@/lib/store/records";
import { compileQuery } from "@/lib/attio/filter";
import { queryRecordRows } from "@/lib/store/records";
import { renderRecords, type AttioCtx } from "@/lib/attio/route-helpers";
import { resolveObject } from "@/lib/store/objects";
import {
  installStandardSchema,
  seedDatabase,
  SEED_MEMBER_OWNER,
  SEED_MEMBER_PRIYA,
  SEED_NOW_MS,
  SEED_OWNER_EMAIL,
  SEED_WORKSPACE_ID,
  SEED_WORKSPACE_NAME,
  SEED_WORKSPACE_SLUG,
} from "@/lib/seed";
import type { Actor } from "@/lib/attio/shape";

// The whole harness: the REAL schema off disk (so a schema regression fails the
// suite) applied to an in-memory database, with production's ATTACHed audit.db
// mirrored so mutation code paths that log can run unchanged under test.

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

export const NOW = SEED_NOW_MS;
export const DAY_MS = 86_400_000;
export const daysBefore = (n: number) => NOW - n * DAY_MS;

export const OWNER_ACTOR: Actor = { type: "workspace-member", id: SEED_MEMBER_OWNER };
export const API_ACTOR: Actor = {
  type: "api-token",
  id: "aa6d3e7f-80af-4d77-8b48-22629a07651c",
};

function baseDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schema);
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);
  return db;
}

/**
 * The registry and the two workspace members, but no records — the starting
 * point for the value-writer tests, which need to watch a record's first value
 * appear.
 */
export function makeEmptyDb(): Database.Database {
  const db = baseDb();
  setMeta(db, "workspace_id", SEED_WORKSPACE_ID);
  setMeta(db, "workspace_name", SEED_WORKSPACE_NAME);
  setMeta(db, "workspace_slug", SEED_WORKSPACE_SLUG);
  setMeta(db, "owner_email", SEED_OWNER_EMAIL);
  setMeta(db, "owner_member_id", SEED_MEMBER_OWNER);
  insertMember(db, {
    id: SEED_MEMBER_OWNER,
    firstName: "Sandbox",
    lastName: "User",
    emailAddress: SEED_OWNER_EMAIL,
    createdAtMs: daysBefore(500),
  });
  insertMember(db, {
    id: SEED_MEMBER_PRIYA,
    firstName: "Priya",
    lastName: "Nair",
    emailAddress: "priya@acme.co",
    createdAtMs: daysBefore(480),
  });
  installStandardSchema(db, daysBefore(500));
  return db;
}

/** The demo world — the shared corpus every read-side suite queries against. */
export function makeSeededDb(): Database.Database {
  const db = baseDb();
  seedDatabase(db);
  return db;
}

/** A bare record with no values yet, for the writer tests. */
export function newRecord(db: Database.Database, objectSlug: string, id: string): void {
  const object = resolveObject(db, objectSlug);
  if (!object) throw new Error(`no object ${objectSlug}`);
  insertRecord(db, { id, objectId: object.id, createdAtMs: NOW });
}

export function testCtx(db: Database.Database): AttioCtx {
  return {
    db,
    workspaceId: SEED_WORKSPACE_ID,
    workspaceSlug: SEED_WORKSPACE_SLUG,
    workspaceName: SEED_WORKSPACE_NAME,
    ownerMemberId: SEED_MEMBER_OWNER,
    actor: API_ACTOR,
  };
}

/** Compile + run a records query the way the route does, and return the ids. */
export function queryIds(
  db: Database.Database,
  objectSlug: string,
  body: Record<string, unknown> = {},
): string[] {
  const object = resolveObject(db, objectSlug);
  if (!object) throw new Error(`no object ${objectSlug}`);
  const compiled = compileQuery(db, object.id, body);
  return queryRecordRows(db, {
    objectId: object.id,
    ...compiled,
    limit: 500,
    offset: 0,
  }).map((r) => r.id);
}

/** Compile + run + shape, for the fidelity suite. */
export function queryRecords(
  db: Database.Database,
  objectSlug: string,
  body: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const object = resolveObject(db, objectSlug);
  if (!object) throw new Error(`no object ${objectSlug}`);
  const compiled = compileQuery(db, object.id, body);
  const rows = queryRecordRows(db, { objectId: object.id, ...compiled, limit: 500, offset: 0 });
  return renderRecords(db, testCtx(db), object, rows);
}
