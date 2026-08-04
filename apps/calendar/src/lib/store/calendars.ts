import type { Database } from "better-sqlite3";
import type { CalendarRow } from "../calendar/shape";
import { getOwnerEmail } from "./meta";

export function listCalendarRows(db: Database): CalendarRow[] {
  // Primary first, then alphabetical — the order Google's calendarList uses.
  return db
    .prepare("SELECT * FROM calendars ORDER BY is_primary DESC, summary COLLATE NOCASE")
    .all() as CalendarRow[];
}

export function getCalendarRow(db: Database, id: string): CalendarRow | null {
  return (db.prepare("SELECT * FROM calendars WHERE id = ?").get(id) as CalendarRow) ?? null;
}

export function getPrimaryCalendar(db: Database): CalendarRow | null {
  return (
    (db
      .prepare("SELECT * FROM calendars WHERE is_primary = 1 LIMIT 1")
      .get() as CalendarRow) ?? null
  );
}

/**
 * Resolve the `calendarId` path segment. Google accepts the literal `primary`
 * (what most SDK callers send) and the owner's address as aliases for the
 * primary calendar; ids are matched case-insensitively because they're
 * email-shaped. Returns null when nothing matches, so the route can 404.
 */
export function resolveCalendar(db: Database, calendarId: string): CalendarRow | null {
  if (calendarId === "primary") return getPrimaryCalendar(db);
  const exact = getCalendarRow(db, calendarId);
  if (exact) return exact;
  if (calendarId.toLowerCase() === getOwnerEmail(db).toLowerCase()) {
    return getPrimaryCalendar(db);
  }
  return (
    (db
      .prepare("SELECT * FROM calendars WHERE id = ? COLLATE NOCASE")
      .get(calendarId) as CalendarRow) ?? null
  );
}

export interface CalendarInput {
  id: string;
  summary: string;
  description?: string | null;
  timeZone: string;
  isPrimary?: boolean;
  accessRole?: string;
  color?: { colorId?: string; backgroundColor?: string; foregroundColor?: string } | null;
}

export function insertCalendar(db: Database, input: CalendarInput): CalendarRow {
  db.prepare(
    `INSERT INTO calendars (id, summary, description, time_zone, is_primary, access_role, color_json, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       summary = excluded.summary,
       description = excluded.description,
       time_zone = excluded.time_zone,
       is_primary = excluded.is_primary,
       access_role = excluded.access_role,
       color_json = excluded.color_json`,
  ).run(
    input.id,
    input.summary,
    input.description ?? null,
    input.timeZone,
    input.isPrimary ? 1 : 0,
    input.accessRole ?? "owner",
    input.color ? JSON.stringify(input.color) : null,
    null,
  );
  const row = getCalendarRow(db, input.id);
  if (!row) throw new Error(`calendar ${input.id} vanished after insert`);
  return row;
}

export function countCalendars(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number }).n;
}
