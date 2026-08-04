import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { checkAuth } from "./auth";
import { toErrorResponse, CalendarError } from "./errors";
import { getDb } from "../db";
import { getDefaultTimeZone, getOwnerEmail } from "../store/meta";
import { resolveCalendar } from "../store/calendars";
import { logAction, type ActionEntry } from "../audit";
import type { CalendarRow } from "./shape";

// Shared plumbing for /calendar/v3/* route handlers: bearer auth and
// Google-shaped error translation. Keeps every route uniform.

export interface CalendarCtx {
  db: Database;
  ownerEmail: string;
  defaultTimeZone: string;
}

export async function handleCalendar(
  req: Request,
  fn: (ctx: CalendarCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  try {
    const db = getDb();
    return await fn({
      db,
      ownerEmail: getOwnerEmail(db),
      defaultTimeZone: getDefaultTimeZone(db),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Resolve the `calendarId` path segment or throw Google's 404. */
export function requireCalendar(db: Database, calendarId: string): CalendarRow {
  const row = resolveCalendar(db, calendarId);
  if (!row) throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");
  return row;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** Calendar returns 204 No Content from events.delete. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Run a mutation atomically: fn performs the calendar change, then the audit
 * row is written in the SAME transaction (audit.db is ATTACHed). The entry is
 * built from fn's result so summaries can reference it.
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
