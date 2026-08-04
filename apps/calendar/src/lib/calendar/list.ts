import type { Database } from "better-sqlite3";
import { attendeesByEvent, listEventRows } from "../store/events";
import { expandEventRows } from "./recurrence";
import { shapeEvent, type CalendarEventResource, type CalendarRow } from "./shape";

// One place that turns "a calendar and a time window" into Google-shaped event
// resources. events.list and the UI's week grid both come through here, so the
// grid can never show a meeting the API denies (a class of bug that would make
// a replay unreadable).

/** Without a timeMax there is no bound to expand a recurrence to; cap at a year. */
const DEFAULT_WINDOW_MS = 366 * 24 * 3600_000;

export interface ListEventsOptions {
  calendar: CalendarRow;
  ownerEmail: string;
  timeMinMs?: number;
  timeMaxMs?: number;
  q?: string;
  singleEvents?: boolean;
  showDeleted?: boolean;
}

export interface ListEventsResult {
  items: CalendarEventResource[];
  /** Latest update stamp across the returned rows — the collection's `updated`. */
  updatedMs: number;
}

export function listEventResources(
  db: Database,
  opts: ListEventsOptions,
): ListEventsResult {
  const rows = listEventRows(db, {
    calendarId: opts.calendar.id,
    timeMinMs: opts.timeMinMs,
    timeMaxMs: opts.timeMaxMs,
    q: opts.q,
    showDeleted: opts.showDeleted,
    includeRecurringMasters: opts.singleEvents === true,
  });

  const attendees = attendeesByEvent(
    db,
    rows.map((r) => r.id),
  );
  const shapeOpts = {
    ownerEmail: opts.ownerEmail,
    calendarTimeZone: opts.calendar.time_zone,
  };

  let items: CalendarEventResource[];
  if (opts.singleEvents) {
    const windowStart = opts.timeMinMs ?? Number.NEGATIVE_INFINITY;
    const windowEnd =
      opts.timeMaxMs ?? (opts.timeMinMs ?? Date.now()) + DEFAULT_WINDOW_MS;
    items = expandEventRows(rows, windowStart, windowEnd, opts.calendar.time_zone).map((e) =>
      shapeEvent(e.row, attendees.get(e.row.id) ?? [], {
        ...shapeOpts,
        instance: e.instanceId
          ? {
              id: e.instanceId,
              startMs: e.startMs,
              endMs: e.endMs,
              originalStartMs: e.originalStartMs,
            }
          : undefined,
      }),
    );
  } else {
    // singleEvents=false returns masters as stored — recurring events keep
    // their RRULE and their first occurrence's times, exactly like Google.
    items = rows.map((row) => shapeEvent(row, attendees.get(row.id) ?? [], shapeOpts));
  }

  const updatedMs = rows.reduce((max, r) => Math.max(max, r.updated_ms), 0);
  return { items, updatedMs };
}
