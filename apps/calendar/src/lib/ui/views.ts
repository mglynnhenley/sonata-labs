import type { Database } from "better-sqlite3";
import { listCalendarRows, resolveCalendar } from "../store/calendars";
import { getOwnerEmail } from "../store/meta";
import { listEventResources } from "../calendar/list";
import type { CalendarEventResource } from "../calendar/shape";

// Flattened projections for the week grid. The UI never talks to /calendar/v3 —
// it would have to re-implement expansion and auth — but it goes through the
// same listEventResources, so grid and API always agree.

export interface CalendarSummary {
  id: string;
  summary: string;
  timeZone: string;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
}

export function listCalendarSummaries(db: Database): CalendarSummary[] {
  return listCalendarRows(db).map((row) => {
    const color = row.color_json
      ? (JSON.parse(row.color_json) as { backgroundColor?: string; foregroundColor?: string })
      : null;
    return {
      id: row.id,
      summary: row.summary,
      timeZone: row.time_zone,
      primary: row.is_primary === 1,
      accessRole: row.access_role,
      backgroundColor: color?.backgroundColor ?? null,
      foregroundColor: color?.foregroundColor ?? null,
    };
  });
}

export interface GridEvent {
  id: string;
  calendarId: string;
  summary: string;
  location: string | null;
  description: string | null;
  startMs: number;
  endMs: number;
  allDay: boolean;
  status: string;
  recurring: boolean;
  organizer: string | null;
  attendees: Array<{ email: string; displayName: string | null; responseStatus: string }>;
  /** True when the sandbox owner declined — the grid renders it struck through. */
  declinedByOwner: boolean;
}

export interface WeekView {
  ownerEmail: string;
  timeZone: string;
  windowStartMs: number;
  windowEndMs: number;
  calendars: CalendarSummary[];
  events: GridEvent[];
}

export interface WeekViewOptions {
  windowStartMs: number;
  windowEndMs: number;
  /** Restrict to one calendar; omit for every calendar the sandbox knows. */
  calendarId?: string;
  q?: string;
}

export function buildWeekView(db: Database, opts: WeekViewOptions): WeekView {
  const ownerEmail = getOwnerEmail(db);
  const all = listCalendarSummaries(db);
  const target = opts.calendarId ? resolveCalendar(db, opts.calendarId) : null;
  const rows = listCalendarRows(db).filter((c) => !target || c.id === target.id);

  const events: GridEvent[] = [];
  for (const calendar of rows) {
    const { items } = listEventResources(db, {
      calendar,
      ownerEmail,
      timeMinMs: opts.windowStartMs,
      timeMaxMs: opts.windowEndMs,
      q: opts.q,
      singleEvents: true,
    });
    for (const item of items) events.push(toGridEvent(item, calendar.id, ownerEmail));
  }
  events.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  return {
    ownerEmail,
    timeZone: rows.find((c) => c.is_primary === 1)?.time_zone ?? all[0]?.timeZone ?? "UTC",
    windowStartMs: opts.windowStartMs,
    windowEndMs: opts.windowEndMs,
    calendars: all,
    events,
  };
}

function toGridEvent(
  item: CalendarEventResource,
  calendarId: string,
  ownerEmail: string,
): GridEvent {
  const allDay = item.start.date !== undefined;
  const startMs = boundMs(item.start);
  const endMs = boundMs(item.end);
  const attendees = (item.attendees ?? []).map((a) => ({
    email: a.email,
    displayName: a.displayName ?? null,
    responseStatus: a.responseStatus,
  }));
  return {
    id: item.id,
    calendarId,
    summary: item.summary ?? "(no title)",
    location: item.location ?? null,
    description: item.description ?? null,
    startMs,
    endMs,
    allDay,
    status: item.status,
    recurring: item.recurrence !== undefined || item.recurringEventId !== undefined,
    organizer: item.organizer?.email ?? null,
    attendees,
    declinedByOwner: attendees.some(
      (a) => a.responseStatus === "declined" && a.email.toLowerCase() === ownerEmail.toLowerCase(),
    ),
  };
}

function boundMs(bound: { date?: string; dateTime?: string }): number {
  const text = bound.dateTime ?? bound.date;
  return text ? Date.parse(text) : 0;
}
