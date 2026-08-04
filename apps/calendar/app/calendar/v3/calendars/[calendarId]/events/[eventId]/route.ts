import {
  handleCalendar,
  json,
  noContent,
  requireCalendar,
  runMutation,
} from "@/lib/calendar/route-helpers";
import { CalendarError } from "@/lib/calendar/errors";
import { buildUpdate, type EventBody } from "@/lib/calendar/event-input";
import { shapeEvent } from "@/lib/calendar/shape";
import { masterIdOf } from "@/lib/calendar/ids";
import { expandRecurrence } from "@/lib/calendar/recurrence";
import { cancelEvent, getEventRow, listAttendees, updateEvent } from "@/lib/store/events";
import { parseIcalDate } from "@/lib/calendar/time";
import type { Database } from "better-sqlite3";
import type { EventRow } from "@/lib/calendar/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Resolved {
  row: EventRow;
  /** Set when the id addressed one expanded occurrence of a recurring master. */
  instance?: { id: string; startMs: number; endMs: number; originalStartMs: number };
}

/**
 * Resolve an event id. Google lets agents address a single occurrence with the
 * instance id it handed out (`<master>_20260728T133000Z`), so accept both and
 * fall back to the master when the suffix names a real occurrence.
 */
function resolveEvent(
  db: Database,
  calendarId: string,
  eventId: string,
  calendarTimeZone: string,
): Resolved {
  const direct = getEventRow(db, calendarId, eventId);
  if (direct) return { row: direct };

  const masterId = masterIdOf(eventId);
  const master = masterId ? getEventRow(db, calendarId, masterId) : null;
  if (!master || !master.recurrence_json) {
    throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");
  }
  const suffix = eventId.slice(masterId!.length + 1);
  const zone = master.start_tz ?? calendarTimeZone;
  const originalStartMs = parseIcalDate(suffix, zone);
  if (originalStartMs === null) {
    throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");
  }
  const [occurrence] = expandRecurrence({
    startMs: master.start_ms,
    endMs: master.end_ms,
    allDay: master.all_day === 1,
    timeZone: zone,
    recurrence: JSON.parse(master.recurrence_json) as string[],
    windowStartMs: originalStartMs,
    windowEndMs: originalStartMs + 1,
  });
  if (!occurrence || occurrence.startMs !== originalStartMs) {
    throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");
  }
  return {
    row: master,
    instance: {
      id: eventId,
      startMs: occurrence.startMs,
      endMs: occurrence.endMs,
      originalStartMs: occurrence.originalStartMs,
    },
  };
}

// events.get
export async function GET(
  req: Request,
  { params }: { params: Promise<{ calendarId: string; eventId: string }> },
) {
  const { calendarId, eventId } = await params;
  return handleCalendar(req, ({ db, ownerEmail }) => {
    const calendar = requireCalendar(db, calendarId);
    const resolved = resolveEvent(db, calendar.id, eventId, calendar.time_zone);
    return json(
      shapeEvent(resolved.row, listAttendees(db, resolved.row.id), {
        ownerEmail,
        calendarTimeZone: calendar.time_zone,
        instance: resolved.instance,
      }),
    );
  });
}

async function write(
  req: Request,
  params: Promise<{ calendarId: string; eventId: string }>,
  mode: "update" | "patch",
) {
  const { calendarId, eventId } = await params;
  return handleCalendar(req, async ({ db, ownerEmail }) => {
    const calendar = requireCalendar(db, calendarId);
    // Writes always land on the stored row — the sandbox does not split a
    // series into a modified single instance (see recurrence.ts limits).
    const existing = getEventRow(db, calendar.id, eventId);
    if (!existing) throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");

    const body = (await req.json().catch(() => ({}))) as EventBody;
    const update = buildUpdate(body, existing, {
      calendarId: calendar.id,
      calendarTimeZone: calendar.time_zone,
      ownerEmail,
      now: Date.now(),
    }, mode);
    const endpoint = new URL(req.url).pathname;

    const row = runMutation(
      db,
      () => updateEvent(db, calendar.id, eventId, update),
      (r) => ({
        method: req.method,
        endpoint,
        actionType: mode === "patch" ? "eventPatch" : "eventUpdate",
        targetType: "event",
        targetId: r.id,
        request: body,
        responseCode: 200,
        summary: `${mode === "patch" ? "Patched" : "Updated"} “${r.summary ?? "(no title)"}” on ${calendar.summary}`,
      }),
    );

    return json(
      shapeEvent(row, listAttendees(db, row.id), {
        ownerEmail,
        calendarTimeZone: calendar.time_zone,
      }),
    );
  });
}

export const PUT = (
  req: Request,
  { params }: { params: Promise<{ calendarId: string; eventId: string }> },
) => write(req, params, "update");

export const PATCH = (
  req: Request,
  { params }: { params: Promise<{ calendarId: string; eventId: string }> },
) => write(req, params, "patch");

// events.delete — tombstones to status 'cancelled'; a second delete is 410.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ calendarId: string; eventId: string }> },
) {
  const { calendarId, eventId } = await params;
  return handleCalendar(req, ({ db }) => {
    const calendar = requireCalendar(db, calendarId);
    const endpoint = new URL(req.url).pathname;
    const existing = getEventRow(db, calendar.id, eventId);
    if (!existing) throw new CalendarError(404, "Not Found", "notFound", "NOT_FOUND");

    runMutation(
      db,
      () => cancelEvent(db, calendar.id, eventId),
      () => ({
        method: "DELETE",
        endpoint,
        actionType: "eventDelete",
        targetType: "event",
        targetId: eventId,
        responseCode: 204,
        summary: `Cancelled “${existing.summary ?? "(no title)"}” on ${calendar.summary}`,
      }),
    );
    return noContent();
  });
}
