import { formatDateOnly, formatRfc3339, parseRfc3339 } from "./time";

// ---------------------------------------------------------------------------
// The fidelity linchpin, calendar edition. Columns are the source of truth for
// everything the API can filter or mutate on; raw_json carries the passthrough
// fields Google returns but the sandbox doesn't reason about (colorId,
// conferenceData, …). Every read rebuilds a Google Calendar v3 resource from
// the columns and layers the passthrough on underneath, so the official SDK
// can't tell a seeded event from a real one.
// ---------------------------------------------------------------------------

export interface CalendarRow {
  id: string;
  summary: string;
  description: string | null;
  time_zone: string;
  is_primary: number;
  access_role: string;
  color_json: string | null;
  raw_json: string | null;
}

export interface EventRow {
  id: string;
  calendar_id: string;
  status: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_ms: number;
  end_ms: number;
  all_day: number;
  start_tz: string | null;
  end_tz: string | null;
  recurrence_json: string | null;
  organizer_email: string | null;
  ical_uid: string | null;
  created_ms: number;
  updated_ms: number;
  raw_json: string;
  is_sandbox_created: number;
}

export interface AttendeeRow {
  event_id: string;
  email: string;
  display_name: string | null;
  response_status: string;
  optional: number;
}

// --- resources ---------------------------------------------------------------

export interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface EventPerson {
  email: string;
  displayName?: string;
  self?: boolean;
}

export interface EventAttendee extends EventPerson {
  organizer?: boolean;
  optional?: boolean;
  responseStatus: string;
}

export interface CalendarEventResource {
  kind: "calendar#event";
  etag: string;
  id: string;
  status: string;
  htmlLink: string;
  created: string;
  updated: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: EventPerson;
  organizer?: EventPerson;
  start: EventDateTime;
  end: EventDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventDateTime;
  iCalUID: string;
  sequence: number;
  attendees?: EventAttendee[];
  reminders: { useDefault: boolean };
  eventType: string;
  [key: string]: unknown;
}

export interface CalendarListEntry {
  kind: "calendar#calendarListEntry";
  etag: string;
  id: string;
  summary: string;
  description?: string;
  timeZone: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  selected: boolean;
  accessRole: string;
  defaultReminders: never[];
  primary?: boolean;
}

// Fields Google returns that the sandbox stores but never interprets. Kept in
// raw_json and echoed back verbatim so a round-trip through the SDK is lossless.
const PASSTHROUGH_KEYS = [
  "sequence",
  "eventType",
  "colorId",
  "transparency",
  "visibility",
  "conferenceData",
  "hangoutLink",
  "extendedProperties",
  "attachments",
  "source",
  "guestsCanModify",
  "guestsCanInviteOthers",
  "guestsCanSeeOtherGuests",
  "anyoneCanAddSelf",
  "privateCopy",
  "locked",
] as const;

export function passthroughOf(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const key of PASSTHROUGH_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** Google's etags are quoted opaque strings; ours keys off the update stamp. */
export function etagFor(updatedMs: number, discriminator = ""): string {
  return `"${updatedMs}${discriminator ? `-${discriminator}` : ""}"`;
}

/** Google's event permalink: base64url of "<eventId> <calendarId>". */
export function htmlLinkFor(eventId: string, calendarId: string): string {
  const eid = Buffer.from(`${eventId} ${calendarId}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://www.google.com/calendar/event?eid=${eid}`;
}

/** Epoch ms → the `{date}` or `{dateTime,timeZone}` half of an event. */
export function toEventDateTime(ms: number, allDay: boolean, timeZone: string): EventDateTime {
  if (allDay) return { date: formatDateOnly(ms) };
  return { dateTime: formatRfc3339(ms, timeZone), timeZone };
}

export interface ParsedBound {
  ms: number;
  allDay: boolean;
  timeZone: string | null;
}

/**
 * `{date}` / `{dateTime,timeZone}` → epoch ms. Returns null when neither field
 * is usable so callers can raise Google's "Missing start/end time." 400.
 */
export function parseEventDateTime(
  value: unknown,
  defaultTimeZone: string,
): ParsedBound | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  const zone = typeof v.timeZone === "string" && v.timeZone ? v.timeZone : null;
  if (typeof v.date === "string" && v.date) {
    const ms = parseRfc3339(v.date, "UTC");
    return ms === null ? null : { ms, allDay: true, timeZone: zone };
  }
  if (typeof v.dateTime === "string" && v.dateTime) {
    const ms = parseRfc3339(v.dateTime, zone ?? defaultTimeZone);
    return ms === null ? null : { ms, allDay: false, timeZone: zone ?? defaultTimeZone };
  }
  return null;
}

// --- shaping -----------------------------------------------------------------

export interface ShapeEventOptions {
  ownerEmail: string;
  calendarTimeZone: string;
  /** Set when shaping one expanded occurrence of a recurring master. */
  instance?: { startMs: number; endMs: number; originalStartMs: number; id: string };
}

export function shapeEvent(
  row: EventRow,
  attendees: AttendeeRow[],
  opts: ShapeEventOptions,
): CalendarEventResource {
  const extra = passthroughOf(safeParse(row.raw_json));
  const allDay = row.all_day === 1;
  const startZone = row.start_tz ?? opts.calendarTimeZone;
  const endZone = row.end_tz ?? startZone;
  const startMs = opts.instance ? opts.instance.startMs : row.start_ms;
  const endMs = opts.instance ? opts.instance.endMs : row.end_ms;
  const organizerEmail = row.organizer_email ?? opts.ownerEmail;

  const resource: CalendarEventResource = {
    ...extra,
    kind: "calendar#event",
    etag: etagFor(row.updated_ms, opts.instance?.id),
    id: opts.instance ? opts.instance.id : row.id,
    status: row.status,
    htmlLink: htmlLinkFor(row.id, row.calendar_id),
    created: new Date(row.created_ms).toISOString(),
    updated: new Date(row.updated_ms).toISOString(),
    creator: personFor(organizerEmail, opts.ownerEmail),
    organizer: personFor(organizerEmail, opts.ownerEmail),
    start: toEventDateTime(startMs, allDay, startZone),
    end: toEventDateTime(endMs, allDay, endZone),
    iCalUID: row.ical_uid ?? `${row.id}@google.com`,
    sequence: typeof extra.sequence === "number" ? extra.sequence : 0,
    reminders: { useDefault: true },
    eventType: typeof extra.eventType === "string" ? extra.eventType : "default",
  };

  if (row.summary !== null) resource.summary = row.summary;
  if (row.description !== null) resource.description = row.description;
  if (row.location !== null) resource.location = row.location;

  const recurrence = safeParse(row.recurrence_json);
  if (Array.isArray(recurrence) && recurrence.length) {
    // Instances never carry the rule — they point back at the master instead.
    if (opts.instance) {
      resource.recurringEventId = row.id;
      resource.originalStartTime = toEventDateTime(
        opts.instance.originalStartMs,
        allDay,
        startZone,
      );
    } else {
      resource.recurrence = recurrence as string[];
    }
  }

  if (attendees.length) {
    resource.attendees = attendees.map((a) => {
      const attendee: EventAttendee = {
        email: a.email,
        responseStatus: a.response_status,
      };
      if (a.display_name) attendee.displayName = a.display_name;
      if (a.optional === 1) attendee.optional = true;
      if (a.email.toLowerCase() === organizerEmail.toLowerCase()) attendee.organizer = true;
      if (a.email.toLowerCase() === opts.ownerEmail.toLowerCase()) attendee.self = true;
      return attendee;
    });
  }

  return resource;
}

function personFor(email: string, ownerEmail: string): EventPerson {
  const person: EventPerson = { email };
  if (email.toLowerCase() === ownerEmail.toLowerCase()) person.self = true;
  return person;
}

export function shapeCalendarListEntry(row: CalendarRow): CalendarListEntry {
  const color = safeParse(row.color_json) as
    | { colorId?: string; backgroundColor?: string; foregroundColor?: string }
    | null;
  const entry: CalendarListEntry = {
    kind: "calendar#calendarListEntry",
    etag: etagFor(0, row.id),
    id: row.id,
    summary: row.summary,
    timeZone: row.time_zone,
    selected: true,
    accessRole: row.access_role,
    defaultReminders: [],
  };
  if (row.description) entry.description = row.description;
  if (color?.colorId) entry.colorId = color.colorId;
  if (color?.backgroundColor) entry.backgroundColor = color.backgroundColor;
  if (color?.foregroundColor) entry.foregroundColor = color.foregroundColor;
  // Google omits `primary` entirely on secondary calendars rather than sending false.
  if (row.is_primary === 1) entry.primary = true;
  return entry;
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
