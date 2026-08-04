import type { Database } from "better-sqlite3";
import type { AttendeeRow, EventRow } from "../calendar/shape";
import { newEventId, icalUidFor } from "../calendar/ids";
import { CalendarError } from "../calendar/errors";

export interface AttendeeInput {
  email: string;
  displayName?: string | null;
  responseStatus?: string;
  optional?: boolean;
}

export interface EventInput {
  id?: string;
  calendarId: string;
  status?: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startMs: number;
  endMs: number;
  allDay: boolean;
  startTz?: string | null;
  endTz?: string | null;
  recurrence?: string[] | null;
  organizerEmail?: string | null;
  icalUid?: string | null;
  createdMs?: number;
  updatedMs?: number;
  /** Passthrough resource fields (colorId, transparency, …). */
  extra?: Record<string, unknown>;
  attendees?: AttendeeInput[];
  isSandboxCreated?: boolean;
}

export function getEventRow(db: Database, calendarId: string, eventId: string): EventRow | null {
  return (
    (db
      .prepare("SELECT * FROM events WHERE calendar_id = ? AND id = ?")
      .get(calendarId, eventId) as EventRow) ?? null
  );
}

export function listAttendees(db: Database, eventId: string): AttendeeRow[] {
  return db
    .prepare("SELECT * FROM event_attendees WHERE event_id = ? ORDER BY rowid")
    .all(eventId) as AttendeeRow[];
}

/** Attendees for many events in one query — avoids N+1 on list responses. */
export function attendeesByEvent(
  db: Database,
  eventIds: string[],
): Map<string, AttendeeRow[]> {
  const out = new Map<string, AttendeeRow[]>();
  if (!eventIds.length) return out;
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM event_attendees WHERE event_id IN (${placeholders}) ORDER BY rowid`,
    )
    .all(...eventIds) as AttendeeRow[];
  for (const row of rows) {
    const list = out.get(row.event_id);
    if (list) list.push(row);
    else out.set(row.event_id, [row]);
  }
  return out;
}

export function replaceAttendees(
  db: Database,
  eventId: string,
  attendees: AttendeeInput[],
): void {
  db.prepare("DELETE FROM event_attendees WHERE event_id = ?").run(eventId);
  const insert = db.prepare(
    `INSERT INTO event_attendees (event_id, email, display_name, response_status, optional)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, email) DO UPDATE SET
       display_name = excluded.display_name,
       response_status = excluded.response_status,
       optional = excluded.optional`,
  );
  for (const a of attendees) {
    if (!a.email) continue;
    insert.run(
      eventId,
      a.email,
      a.displayName ?? null,
      a.responseStatus ?? "needsAction",
      a.optional ? 1 : 0,
    );
  }
}

export interface EventQuery {
  calendarId: string;
  timeMinMs?: number;
  timeMaxMs?: number;
  q?: string;
  showDeleted?: boolean;
  /**
   * Pull in every recurring master whose series *starts* before the window
   * even if the master itself ends long before it — the expansion step decides
   * which occurrences actually land inside.
   */
  includeRecurringMasters?: boolean;
}

export function listEventRows(db: Database, query: EventQuery): EventRow[] {
  const clauses: string[] = ["calendar_id = ?"];
  const params: unknown[] = [query.calendarId];

  if (!query.showDeleted) clauses.push("status != 'cancelled'");

  const windowClauses: string[] = [];
  if (query.timeMinMs !== undefined) {
    windowClauses.push("end_ms > ?");
    params.push(query.timeMinMs);
  }
  if (query.timeMaxMs !== undefined) {
    windowClauses.push("start_ms < ?");
    params.push(query.timeMaxMs);
  }
  if (windowClauses.length) {
    const window = `(${windowClauses.join(" AND ")})`;
    if (query.includeRecurringMasters) {
      // A master's stored end is the FIRST occurrence's end, so the window test
      // would wrongly exclude a live series. Gate masters on start only.
      const masterClause =
        query.timeMaxMs !== undefined
          ? "(recurrence_json IS NOT NULL AND start_ms < ?)"
          : "(recurrence_json IS NOT NULL)";
      if (query.timeMaxMs !== undefined) params.push(query.timeMaxMs);
      clauses.push(`(${window} OR ${masterClause})`);
    } else {
      clauses.push(window);
    }
  }

  if (query.q) {
    const like = `%${query.q}%`;
    clauses.push(
      `(summary LIKE ? OR description LIKE ? OR location LIKE ?
        OR id IN (SELECT event_id FROM event_attendees
                  WHERE email LIKE ? OR display_name LIKE ?))`,
    );
    params.push(like, like, like, like, like);
  }

  return db
    .prepare(
      `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY start_ms, id`,
    )
    .all(...params) as EventRow[];
}

export function insertEvent(db: Database, input: EventInput): EventRow {
  const id = input.id ?? newEventId();
  const now = Date.now();
  const createdMs = input.createdMs ?? now;
  const updatedMs = input.updatedMs ?? createdMs;
  db.prepare(
    `INSERT INTO events
       (id, calendar_id, status, summary, description, location, start_ms, end_ms, all_day,
        start_tz, end_tz, recurrence_json, organizer_email, ical_uid, created_ms, updated_ms,
        raw_json, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.calendarId,
    input.status ?? "confirmed",
    input.summary ?? null,
    input.description ?? null,
    input.location ?? null,
    input.startMs,
    input.endMs,
    input.allDay ? 1 : 0,
    input.startTz ?? null,
    input.endTz ?? null,
    input.recurrence && input.recurrence.length ? JSON.stringify(input.recurrence) : null,
    input.organizerEmail ?? null,
    input.icalUid ?? icalUidFor(id),
    createdMs,
    updatedMs,
    JSON.stringify(input.extra ?? {}),
    input.isSandboxCreated ? 1 : 0,
  );
  if (input.attendees) replaceAttendees(db, id, input.attendees);
  const row = getEventRow(db, input.calendarId, id);
  if (!row) throw new Error(`event ${id} vanished after insert`);
  return row;
}

export interface EventUpdate {
  status?: string;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  startTz?: string | null;
  endTz?: string | null;
  recurrence?: string[] | null;
  organizerEmail?: string | null;
  extra?: Record<string, unknown>;
  attendees?: AttendeeInput[];
  updatedMs?: number;
}

const UPDATE_COLUMNS: Array<[keyof EventUpdate, string]> = [
  ["status", "status"],
  ["summary", "summary"],
  ["description", "description"],
  ["location", "location"],
  ["startMs", "start_ms"],
  ["endMs", "end_ms"],
  ["startTz", "start_tz"],
  ["endTz", "end_tz"],
  ["organizerEmail", "organizer_email"],
];

/** Apply a partial update. Only keys present on `update` are touched. */
export function updateEvent(
  db: Database,
  calendarId: string,
  eventId: string,
  update: EventUpdate,
): EventRow {
  const existing = getEventRow(db, calendarId, eventId);
  if (!existing) throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of UPDATE_COLUMNS) {
    if (update[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(update[key]);
    }
  }
  if (update.allDay !== undefined) {
    sets.push("all_day = ?");
    params.push(update.allDay ? 1 : 0);
  }
  if (update.recurrence !== undefined) {
    sets.push("recurrence_json = ?");
    params.push(update.recurrence && update.recurrence.length ? JSON.stringify(update.recurrence) : null);
  }
  if (update.extra !== undefined) {
    sets.push("raw_json = ?");
    params.push(JSON.stringify(update.extra));
  }
  sets.push("updated_ms = ?");
  params.push(update.updatedMs ?? Date.now());

  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE calendar_id = ? AND id = ?`).run(
    ...params,
    calendarId,
    eventId,
  );
  if (update.attendees !== undefined) replaceAttendees(db, eventId, update.attendees);

  const row = getEventRow(db, calendarId, eventId);
  if (!row) throw new Error(`event ${eventId} vanished after update`);
  return row;
}

/**
 * events.delete. Google tombstones rather than erases: the row stays with
 * status 'cancelled' so showDeleted=true still surfaces it, and deleting twice
 * is a 410 the way real Calendar answers.
 */
export function cancelEvent(db: Database, calendarId: string, eventId: string, at?: number): void {
  const existing = getEventRow(db, calendarId, eventId);
  if (!existing) throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");
  if (existing.status === "cancelled") {
    throw new CalendarError(410, "Resource has been deleted", "deleted", "NOT_FOUND");
  }
  db.prepare("UPDATE events SET status = 'cancelled', updated_ms = ? WHERE calendar_id = ? AND id = ?").run(
    at ?? Date.now(),
    calendarId,
    eventId,
  );
}

export function countEvents(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

/** Ids of events on this calendar whose owner declined — excluded from freeBusy. */
export function declinedEventIds(db: Database, ownerEmail: string, calendarId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT a.event_id AS id FROM event_attendees a
       JOIN events e ON e.id = a.event_id
       WHERE e.calendar_id = ? AND a.response_status = 'declined'
         AND a.email = ? COLLATE NOCASE`,
    )
    .all(calendarId, ownerEmail) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
