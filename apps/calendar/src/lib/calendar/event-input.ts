import { CalendarError } from "./errors";
import { parseEventDateTime, passthroughOf, type EventRow } from "./shape";
import { isValidTimeZone } from "./time";
import type { AttendeeInput, EventInput, EventUpdate } from "../store/events";

// Request body → store input. Google validates hard here and agents rely on the
// wording of those 400s, so the messages below are Calendar's, verbatim.

export interface EventBody {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  start?: unknown;
  end?: unknown;
  recurrence?: unknown;
  attendees?: unknown;
  organizer?: unknown;
  [key: string]: unknown;
}

const VALID_STATUS = new Set(["confirmed", "tentative", "cancelled"]);
const VALID_RESPONSE = new Set(["needsAction", "declined", "tentative", "accepted"]);

function invalid(message: string, reason = "invalid"): CalendarError {
  return new CalendarError(400, message, reason, "INVALID_ARGUMENT");
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(`Invalid value for: ${field}`);
  return value;
}

function parseRecurrence(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
    throw invalid("Invalid recurrence rule.");
  }
  // Stored verbatim — see the limit note in recurrence.ts. Anything we can't
  // expand still round-trips unchanged.
  return value as string[];
}

export function parseAttendees(value: unknown): AttendeeInput[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw invalid("Invalid attendees list.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw invalid("Invalid attendees list.");
    const a = raw as Record<string, unknown>;
    if (typeof a.email !== "string" || !a.email.includes("@")) {
      throw invalid("Invalid attendee email.", "invalidAttendee");
    }
    const responseStatus =
      typeof a.responseStatus === "string" ? a.responseStatus : "needsAction";
    if (!VALID_RESPONSE.has(responseStatus)) {
      throw invalid(`Invalid attendee response status: ${responseStatus}`);
    }
    return {
      email: a.email,
      displayName: typeof a.displayName === "string" ? a.displayName : null,
      responseStatus,
      optional: a.optional === true,
    };
  });
}

interface Bounds {
  startMs: number;
  endMs: number;
  allDay: boolean;
  startTz: string | null;
  endTz: string | null;
}

function parseBounds(body: EventBody, calendarTimeZone: string): Bounds {
  const start = parseEventDateTime(body.start, calendarTimeZone);
  if (!start) throw invalid("Missing start time.", "required");
  const end = parseEventDateTime(body.end, calendarTimeZone);
  if (!end) throw invalid("Missing end time.", "required");
  if (start.allDay !== end.allDay) {
    throw invalid("Event start and end must both be dates or both be date-times.");
  }
  for (const bound of [start, end]) {
    if (bound.timeZone && !isValidTimeZone(bound.timeZone)) {
      throw invalid(`Invalid time zone definition: ${bound.timeZone}`, "invalidTimeZone");
    }
  }
  if (end.ms < start.ms) {
    throw invalid("The event's end time must not be before its start time.");
  }
  return {
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
    startTz: start.allDay ? null : start.timeZone,
    endTz: start.allDay ? null : (end.timeZone ?? start.timeZone),
  };
}

function parseStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !VALID_STATUS.has(value)) {
    throw invalid(`Invalid value for: ${String(value)}`, "invalidStatus");
  }
  return value;
}

function organizerEmailOf(body: EventBody): string | undefined {
  const organizer = body.organizer;
  if (!organizer || typeof organizer !== "object") return undefined;
  const email = (organizer as { email?: unknown }).email;
  return typeof email === "string" ? email : undefined;
}

export interface BuildContext {
  calendarId: string;
  calendarTimeZone: string;
  ownerEmail: string;
  now: number;
}

/** events.insert — start and end are required. */
export function buildInsertInput(body: EventBody, ctx: BuildContext): EventInput {
  const bounds = parseBounds(body, ctx.calendarTimeZone);
  return {
    id: typeof body.id === "string" && body.id ? body.id : undefined,
    calendarId: ctx.calendarId,
    status: parseStatus(body.status) ?? "confirmed",
    summary: optionalString(body.summary, "summary") ?? null,
    description: optionalString(body.description, "description") ?? null,
    location: optionalString(body.location, "location") ?? null,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    allDay: bounds.allDay,
    startTz: bounds.startTz,
    endTz: bounds.endTz,
    recurrence: parseRecurrence(body.recurrence) ?? null,
    organizerEmail: organizerEmailOf(body) ?? ctx.ownerEmail,
    createdMs: ctx.now,
    updatedMs: ctx.now,
    extra: passthroughOf(body),
    attendees: parseAttendees(body.attendees) ?? [],
    isSandboxCreated: true,
  };
}

/**
 * events.update (PUT) replaces the whole resource: fields the caller omits are
 * cleared. events.patch (PATCH) touches only what it sends.
 */
export function buildUpdate(
  body: EventBody,
  existing: EventRow,
  ctx: BuildContext,
  mode: "update" | "patch",
): EventUpdate {
  const update: EventUpdate = { updatedMs: ctx.now };

  if (mode === "update") {
    const bounds = parseBounds(body, existing.start_tz ?? ctx.calendarTimeZone);
    update.startMs = bounds.startMs;
    update.endMs = bounds.endMs;
    update.allDay = bounds.allDay;
    update.startTz = bounds.startTz;
    update.endTz = bounds.endTz;
    update.status = parseStatus(body.status) ?? "confirmed";
    update.summary = optionalString(body.summary, "summary") ?? null;
    update.description = optionalString(body.description, "description") ?? null;
    update.location = optionalString(body.location, "location") ?? null;
    update.recurrence = parseRecurrence(body.recurrence) ?? null;
    update.organizerEmail = organizerEmailOf(body) ?? existing.organizer_email;
    update.extra = passthroughOf(body);
    update.attendees = parseAttendees(body.attendees) ?? [];
    return update;
  }

  // PATCH: start and end move together or not at all, and the pair is
  // re-validated against whatever the event already has.
  if (body.start !== undefined || body.end !== undefined) {
    const zone = existing.start_tz ?? ctx.calendarTimeZone;
    const merged: EventBody = {
      start:
        body.start !== undefined
          ? body.start
          : boundToBody(existing.start_ms, existing.all_day === 1, existing.start_tz, zone),
      end:
        body.end !== undefined
          ? body.end
          : boundToBody(existing.end_ms, existing.all_day === 1, existing.end_tz, zone),
    };
    const bounds = parseBounds(merged, zone);
    update.startMs = bounds.startMs;
    update.endMs = bounds.endMs;
    update.allDay = bounds.allDay;
    update.startTz = bounds.startTz;
    update.endTz = bounds.endTz;
  }

  const status = parseStatus(body.status);
  if (status !== undefined) update.status = status;
  const summary = optionalString(body.summary, "summary");
  if (summary !== undefined) update.summary = summary;
  const description = optionalString(body.description, "description");
  if (description !== undefined) update.description = description;
  const location = optionalString(body.location, "location");
  if (location !== undefined) update.location = location;
  const recurrence = parseRecurrence(body.recurrence);
  if (recurrence !== undefined) update.recurrence = recurrence;
  const organizer = organizerEmailOf(body);
  if (organizer !== undefined) update.organizerEmail = organizer;
  const attendees = parseAttendees(body.attendees);
  if (attendees !== undefined) update.attendees = attendees;

  const passthrough = passthroughOf(body);
  if (Object.keys(passthrough).length) {
    const previous = passthroughOf(existing.raw_json ? JSON.parse(existing.raw_json) : null);
    update.extra = { ...previous, ...passthrough };
  }

  return update;
}

/** Rebuild the `{date}`/`{dateTime}` half of a bound so PATCH can re-validate it. */
function boundToBody(
  ms: number,
  allDay: boolean,
  storedZone: string | null,
  fallbackZone: string,
): unknown {
  if (allDay) {
    const d = new Date(ms);
    const p = (n: number, w = 2): string => String(n).padStart(w, "0");
    return { date: `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` };
  }
  return { dateTime: new Date(ms).toISOString(), timeZone: storedZone ?? fallbackZone };
}
