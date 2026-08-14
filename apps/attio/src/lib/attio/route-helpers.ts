import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { API_TOKEN_ACTOR, checkAuth } from "./auth";
import { notFoundError, notImplementedError, toErrorResponse } from "./errors";
import { liveDb } from "../sandbox/live";
import { logAction, type ActionEntry } from "../audit";
import {
  getOwnerMemberId,
  getWorkspaceId,
  getWorkspaceName,
  getWorkspaceSlug,
} from "../store/meta";
import { listAttributes, resolveObject, statusesByAttribute } from "../store/objects";
import { activeValuesFor, getRecordRow } from "../store/records";
import { getMemberById } from "../store/members";
import { getTaskRow } from "../store/tasks";
import {
  shapeRecord,
  type Actor,
  type MemberRow,
  type ObjectRow,
  type RecordRow,
  type ShapeCtx,
  type TaskRow,
} from "./shape";

// The wrapper every /v2 route goes through. Nothing in a route touches getDb()
// or checkAuth() directly, so auth, the workspace identity and Attio's error
// envelope are decided in exactly one place.

export interface AttioCtx extends ShapeCtx {
  db: Database;
  /** Who a write made through this API is attributed to. */
  actor: Actor;
}

export async function handleAttio(
  req: Request,
  fn: (ctx: AttioCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  try {
    // liveDb() rather than getDb(): the sibling clones only refresh the handle
    // inside /api/sandbox/*, which is why a Gmail seeded out-of-process can go
    // on serving the old inode through its provider API until a restart. One
    // stat per request buys that whole class of bug away.
    const db = liveDb();
    return await fn({
      db,
      workspaceId: getWorkspaceId(db),
      workspaceSlug: getWorkspaceSlug(db),
      workspaceName: getWorkspaceName(db),
      ownerMemberId: getOwnerMemberId(db),
      actor: { ...API_TOKEN_ACTOR },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

// Attio words its 404s differently per resource, and agents string-match on
// them: objects take a slug OR an id, so their message says "slug/ID"; records,
// tasks and members are addressed by UUID only, so theirs does not — and the
// task sentence is a different shape entirely.

export function requireObject(db: Database, slugOrId: string): ObjectRow {
  const row = resolveObject(db, slugOrId);
  if (!row) throw notFoundError(`Object with slug/ID "${slugOrId}" not found.`);
  return row;
}

export function requireRecord(db: Database, objectId: string, recordId: string): RecordRow {
  const row = getRecordRow(db, objectId, recordId);
  if (!row) throw notFoundError(`Record with ID "${recordId}" not found.`);
  return row;
}

export function requireTask(db: Database, taskId: string): TaskRow {
  const row = getTaskRow(db, taskId);
  if (!row) throw notFoundError(`Could not find Task with ID "${taskId}".`);
  return row;
}

export function requireMember(db: Database, memberId: string): MemberRow {
  const row = getMemberById(db, memberId);
  if (!row) throw notFoundError(`WorkspaceMember with ID "${memberId}" not found.`);
  return row;
}

/**
 * Shape a page of records: the object's attributes and every status option are
 * fetched once for the whole page rather than per record.
 */
export function renderRecords(
  db: Database,
  ctx: AttioCtx,
  object: ObjectRow,
  rows: RecordRow[],
): Array<Record<string, unknown>> {
  const attrs = listAttributes(db, object.id);
  const statusById = statusesByAttribute(
    db,
    attrs.filter((a) => a.type === "status").map((a) => a.id),
  );
  const valuesByRecord = activeValuesFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    shapeRecord(ctx, object, row, attrs, valuesByRecord.get(row.id) ?? [], statusById),
  );
}

/**
 * What a human calls this record. Attio treats an object's FIRST attribute as
 * its display name, and the audit summaries quote it so the trail reads as
 * "Moved “Northwind — Platform renewal”" rather than as a pair of UUIDs.
 */
export function recordDisplayName(db: Database, objectId: string, recordId: string): string {
  const primary = listAttributes(db, objectId)[0];
  if (!primary) return recordId;
  const values = activeValuesFor(db, [recordId]).get(recordId) ?? [];
  return values.find((v) => v.attribute_id === primary.id)?.text_value ?? recordId;
}

/**
 * A verb this sandbox refuses, answered in Attio's envelope. Without it Next
 * replies to PUT and DELETE with a bodyless 405, which tells an agent nothing
 * and looks nothing like the vendor.
 */
export function notImplementedRoute(message: string) {
  return async (req: Request): Promise<NextResponse> => {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return toErrorResponse(notImplementedError(message));
  };
}

/**
 * Run a mutation atomically: fn performs the CRM change and the audit row is
 * written in the SAME transaction (audit.db is ATTACHed), so a rolled-back
 * mutation leaves no audit row behind for the judge to read.
 */
export function runMutation<T>(
  db: Database,
  fn: () => T,
  buildEntry: (result: T) => ActionEntry,
): T {
  const tx = db.transaction(() => {
    const result = fn();
    logAction(db, buildEntry(result));
    return result;
  });
  return tx();
}
