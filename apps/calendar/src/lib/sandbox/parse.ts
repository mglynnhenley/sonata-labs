import type {
  ParsedAttendee,
  ParsedCalendar,
  ParsedEvent,
  ParsedSeed,
  WirePerson,
  WireResponseStatus,
} from "./types";

// Validating a cloned business on the way in. Everything here fails loudly with
// a message that names the offending path and says what to fix: a seed that is
// half-understood produces a calendar the agent quietly reasons about wrongly,
// which is far worse than a run that refuses to start.
//
// The one rule doing real work is cast membership. A twin must never invent an
// identity — "Priya on the 2pm invite" is only the same person as "Priya in the
// inbox" because both came out of `world.cast` — so an attendee or organizer the
// world has never heard of is a 400, not a new person.

export class BadRequestError extends Error {}

const DAY_MS = 86_400_000;

const RESPONSE_STATUSES: readonly WireResponseStatus[] = [
  "accepted",
  "declined",
  "tentative",
  "needsAction",
];

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new BadRequestError(`${where}.${key} must be an array`);
  return value;
}

/** For the list fields a hand-written seed reasonably leaves off entirely. */
function optionalArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  return source[key] === undefined || source[key] === null ? [] : array(source, key, where);
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** Absent, null and "" all mean "no value" for the optional prose fields. */
function optionalText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequestError(`${where}.${key} must be a string`);
  return value;
}

function flag(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new BadRequestError(`${where}.${key} must be a boolean`);
  return value;
}

function instant(source: Record<string, unknown>, key: string, where: string): number {
  const raw = text(source, key, where);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(
      `${where}.${key} must be an absolute ISO 8601 timestamp, got "${raw}"`,
    );
  }
  return ms;
}

/** An unknown zone would throw on every later read, so reject it at the door. */
function timezone(source: Record<string, unknown>, key: string, where: string): string {
  const zone = text(source, key, where);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new BadRequestError(`${where}.${key} "${zone}" is not an IANA time zone`);
  }
  return zone;
}

/**
 * The wire carries no all-day flag, so recover it from the timestamps using the
 * same convention the twin stores: an all-day event runs UTC midnight to UTC
 * midnight across whole days.
 */
function isAllDay(startMs: number, endMs: number): boolean {
  return startMs % DAY_MS === 0 && endMs % DAY_MS === 0 && endMs > startMs;
}

function castOf(world: Record<string, unknown>): WirePerson[] {
  return array(world, "cast", "seed.world").map((entry, i) => {
    const where = `seed.world.cast[${i}]`;
    const person = object(entry, where);
    return {
      id: text(person, "id", where),
      name: text(person, "name", where),
      email: text(person, "email", where),
    };
  });
}

function parseCalendars(
  entries: unknown[],
  known: Map<string, string>,
): ParsedCalendar[] {
  const calendars = entries.map((entry, i) => {
    const where = `seed.calendars[${i}]`;
    const raw = object(entry, where);
    const calendar: ParsedCalendar = {
      id: text(raw, "id", where),
      summary: text(raw, "summary", where),
      description: optionalText(raw, "description", where),
      ownerEmail: text(raw, "ownerEmail", where),
      timezone: timezone(raw, "timezone", where),
      primary: flag(raw, "primary", where),
    };
    if (!known.has(calendar.ownerEmail.toLowerCase())) {
      throw new BadRequestError(
        `${where}.ownerEmail "${calendar.ownerEmail}" is not in seed.world.cast — ` +
          `add them to the cast, or point the calendar at someone who is in it`,
      );
    }
    return calendar;
  });

  if (!calendars.length) {
    throw new BadRequestError("seed.calendars must contain at least the owner's primary calendar");
  }
  const ids = new Set<string>();
  for (const calendar of calendars) {
    const key = calendar.id.toLowerCase();
    if (ids.has(key)) {
      throw new BadRequestError(`seed.calendars has two calendars with id "${calendar.id}"`);
    }
    ids.add(key);
  }
  const primaries = calendars.filter((c) => c.primary);
  if (primaries.length !== 1) {
    throw new BadRequestError(
      primaries.length === 0
        ? `no calendar in seed.calendars is marked primary — one must be, because ` +
          `calendarId "primary" and the owner's own address both resolve to it`
        : `seed.calendars marks ${primaries.length} calendars primary ` +
          `(${primaries.map((c) => c.id).join(", ")}); exactly one may be`,
    );
  }
  return calendars;
}

function parseAttendees(
  entries: unknown[],
  where: string,
  organizerEmail: string,
  known: Map<string, string>,
): ParsedAttendee[] {
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const at = `${where}.attendees[${i}]`;
    const raw = object(entry, at);
    const email = text(raw, "email", at);
    const key = email.toLowerCase();

    if (!known.has(key)) {
      throw new BadRequestError(
        `${at}.email "${email}" is not in seed.world.cast — every attendee must come ` +
          `from the one cast, so add them to it rather than to the calendar alone`,
      );
    }
    if (seen.has(key)) throw new BadRequestError(`${where} lists attendee "${email}" twice`);
    seen.add(key);

    const status = raw.responseStatus;
    if (typeof status !== "string" || !RESPONSE_STATUSES.includes(status as WireResponseStatus)) {
      throw new BadRequestError(
        `${at}.responseStatus must be one of ${RESPONSE_STATUSES.join(", ")}, got ` +
          `${JSON.stringify(status)}`,
      );
    }
    // The organizer is a property of the event, not of the attendee row (that is
    // how Google returns it too), so a disagreement would be silently dropped.
    const organizer = raw.organizer === undefined ? false : flag(raw, "organizer", at);
    if (organizer !== (key === organizerEmail.toLowerCase())) {
      throw new BadRequestError(
        `${at} is marked organizer: ${organizer} but ${where}.organizerEmail is ` +
          `"${organizerEmail}" — the two must agree`,
      );
    }

    return {
      email,
      // Verbatim when the wire gives one; otherwise the cast's spelling, which is
      // where it came from anyway. Never a name this twin made up.
      displayName: optionalText(raw, "displayName", at) || (known.get(key) ?? ""),
      responseStatus: status as WireResponseStatus,
    };
  });
}

function parseEvents(
  entries: unknown[],
  calendars: ParsedCalendar[],
  known: Map<string, string>,
): ParsedEvent[] {
  const zoneById = new Map(calendars.map((c) => [c.id.toLowerCase(), c.timezone]));
  const ids = new Set<string>();

  return entries.map((entry, i) => {
    const where = `seed.events[${i}]`;
    const raw = object(entry, where);

    const id = text(raw, "id", where);
    if (ids.has(id)) throw new BadRequestError(`seed.events has two events with id "${id}"`);
    ids.add(id);

    const calendarId = text(raw, "calendarId", where);
    const zone = zoneById.get(calendarId.toLowerCase());
    if (zone === undefined) {
      throw new BadRequestError(
        `${where}.calendarId "${calendarId}" names no calendar in seed.calendars — ` +
          `an event can only land on a calendar this seed creates`,
      );
    }

    const startMs = instant(raw, "startISO", where);
    const endMs = instant(raw, "endISO", where);
    if (endMs < startMs) {
      throw new BadRequestError(
        `${where} ends (${raw.endISO as string}) before it starts (${raw.startISO as string})`,
      );
    }

    const organizerEmail = text(raw, "organizerEmail", where);
    if (!known.has(organizerEmail.toLowerCase())) {
      throw new BadRequestError(
        `${where}.organizerEmail "${organizerEmail}" is not in seed.world.cast`,
      );
    }

    const recurrence = optionalArray(raw, "recurrence", where).map((line, r) => {
      if (typeof line !== "string" || !line.trim()) {
        throw new BadRequestError(`${where}.recurrence[${r}] must be an RFC 5545 line`);
      }
      return line;
    });

    return {
      id,
      // Store under the id the seed gave the calendar, whatever case it used.
      calendarId: calendars.find((c) => c.id.toLowerCase() === calendarId.toLowerCase())?.id ?? calendarId,
      summary: text(raw, "summary", where),
      description: optionalText(raw, "description", where),
      location: optionalText(raw, "location", where),
      startMs,
      endMs,
      allDay: isAllDay(startMs, endMs),
      timezone: zone,
      recurrence,
      organizerEmail,
      attendees: parseAttendees(
        optionalArray(raw, "attendees", where),
        where,
        organizerEmail,
        known,
      ),
    };
  });
}

/** The whole request, checked. Throws `BadRequestError` with a fixable message. */
export function parseSeedRequest(body: unknown): ParsedSeed {
  const root = object(body, "body");

  // Redundant with the URL on purpose: a mis-routed seed has to be loud, because
  // the alternative is an empty calendar that answers 200.
  if (root.twin !== "calendar") {
    throw new BadRequestError(
      `this twin seeds 'calendar', not ${JSON.stringify(root.twin)} — post the calendar ` +
        `wire seed here and the others to their own twins`,
    );
  }

  const seed = object(root.seed, "seed");
  const world = object(seed.world, "seed.world");
  const cast = castOf(world);
  // email (lowercased) -> the cast's spelling of that person's name.
  const known = new Map(cast.map((p) => [p.email.toLowerCase(), p.name]));

  const ownerEmail = text(seed, "ownerEmail", "seed");
  const ownerName = known.get(ownerEmail.toLowerCase());
  if (ownerName === undefined) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" is not in seed.world.cast — the calendar owner ` +
        `must be a member of the cast the other twins seeded from`,
    );
  }

  const calendars = parseCalendars(array(seed, "calendars", "seed"), known);
  const events = parseEvents(array(seed, "events", "seed"), calendars, known);
  const business = object(world.business, "seed.world.business");

  const promote = seed.promoteToSnapshot;
  if (promote !== undefined && typeof promote !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean when present");
  }

  return {
    nowMs: instant(seed, "nowISO", "seed"),
    ownerEmail,
    ownerName,
    // The primary calendar's zone is the owner's zone; `world.timezone` is only
    // a hint and the two agree in every seed the resolver builds.
    timezone: calendars.find((c) => c.primary)?.timezone ?? "UTC",
    businessName: text(business, "name", "seed.world.business"),
    promoteToSnapshot: promote === true,
    calendars,
    events,
  };
}
