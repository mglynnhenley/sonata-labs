import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { logAction, type ActionEntry } from "../audit";
import { getDb } from "../db";
import { loadDocument } from "../store/documents";
import { getOwnerEmail } from "../store/meta";
import { checkAuth } from "./auth";
import { notFoundError, toErrorResponse } from "./errors";
import type { DocModel } from "./shape";

// Shared plumbing for /v1/* route handlers: bearer auth, Docs-shaped error
// translation and the one-transaction mutation wrapper. Nothing in a route calls
// getDb() or checkAuth() directly, so a new route cannot forget either.

export interface DocsCtx {
  db: Database;
  ownerEmail: string;
}

export async function handleDocs(
  req: Request,
  fn: (ctx: DocsCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  try {
    const db = getDb();
    return await fn({ db, ownerEmail: getOwnerEmail(db) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Resolve the `documentId` path segment or throw the vendor's 404. */
export function requireDocument(db: Database, documentId: string): DocModel {
  const model = loadDocument(db, documentId);
  if (!model) throw notFoundError();
  return model;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/**
 * Run a mutation atomically: fn performs the document change, then the audit row
 * is written in the SAME transaction (audit.db is ATTACHed). The entry is built
 * from fn's result so summaries can quote the new id — and a batch that throws
 * rolls back the document and its audit row together.
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

/**
 * Split `1AbC…:batchUpdate` into its id and its custom method.
 *
 * Google's write endpoint is `/v1/documents/{documentId}:batchUpdate` — a
 * `resource:verb` custom method, not a path segment. Next hands the whole thing
 * to the `[documentId]` dynamic param unmodified, and googleapis leaves the
 * literal `:batchUpdate` unencoded, so splitting on the LAST colon here is all
 * that is needed. Verified against Next 16.3 and googleapis 144.
 */
export function splitCustomMethod(segment: string): [documentId: string, method: string | null] {
  const at = segment.lastIndexOf(":");
  if (at < 0) return [segment, null];
  return [segment.slice(0, at), segment.slice(at + 1)];
}
