import { NextResponse } from "next/server";
import { checkAuth } from "./auth";
import { toErrorResponse, badRequest } from "./errors";
import { getDb } from "../db";
import { getProfileEmail } from "../store/meta";
import type { Database } from "better-sqlite3";

// Shared plumbing for /gmail/v1/* route handlers: bearer auth, userId
// validation, and Gmail-shaped error translation. Keeps every route uniform.

export interface GmailCtx {
  db: Database;
  userId: string;
}

/**
 * Wrap a handler with auth + error handling. `userId` from the route is
 * validated to be `me` or the synced profile email (Gmail 400s otherwise).
 */
export async function handleGmail(
  req: Request,
  userIdParam: string,
  fn: (ctx: GmailCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  try {
    const db = getDb();
    const email = getProfileEmail(db);
    if (userIdParam !== "me" && userIdParam.toLowerCase() !== email.toLowerCase()) {
      return badRequest(`Invalid userId '${userIdParam}'.`);
    }
    return await fn({ db, userId: email });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** Gmail returns 204 No Content for delete/batch operations. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

import { logAction, type ActionEntry } from "../audit";

/**
 * Run a mutation atomically: fn performs the mailbox change + history bump, then
 * the audit row is written in the SAME transaction (audit.db is ATTACHed). The
 * audit entry is built from fn's result so summaries can reference it.
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
