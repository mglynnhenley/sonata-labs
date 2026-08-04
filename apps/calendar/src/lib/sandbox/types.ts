// The Calendar twin's half of the seed contract. The contract itself is written
// out in full at the top of packages/world/src/inject.ts; these are the shapes
// that arrive on the wire.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. Everything below is
// structurally compatible with `CalendarWireSeed` and friends, and that
// compatibility is the contract.

/** Structurally core's `Person`. Only the fields this twin actually reads. */
export interface WirePerson {
  id: string;
  name: string;
  email: string;
}

/** Structurally core's `WorldSeed`. The cast is what makes the clone coherent. */
export interface WireWorld {
  business: { name: string };
  cast: WirePerson[];
  mailboxOwner: string;
  timezone?: string;
}

export type WireResponseStatus = "accepted" | "declined" | "tentative" | "needsAction";

export interface CalendarWireAttendee {
  email: string;
  displayName: string;
  responseStatus: WireResponseStatus;
  organizer: boolean;
}

export interface CalendarWireEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  startISO: string;
  endISO: string;
  /** RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. Empty for a one-off. */
  recurrence: string[];
  organizerEmail: string;
  attendees: CalendarWireAttendee[];
}

export interface CalendarWireCalendar {
  id: string;
  summary: string;
  description: string;
  ownerEmail: string;
  timezone: string;
  /** The owner's own calendar — the one a new event lands on by default. */
  primary: boolean;
}

export interface CalendarWireSeed {
  world: WireWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. Absent means no. */
  promoteToSnapshot?: boolean;
  ownerEmail: string;
  calendars: CalendarWireCalendar[];
  events: CalendarWireEvent[];
}

export interface SeedRequest {
  twin: "calendar";
  seed: CalendarWireSeed;
}

/** `counts` is what was actually written, read back out of the DB. */
export interface SeedResult {
  ok: true;
  counts: { calendars: number; events: number };
}

// ---------------------------------------------------------------------------
// Validated form. Parsing turns the wire into exactly this and nothing else, so
// the writer below cannot see an unchecked string or an unparsed timestamp.
// ---------------------------------------------------------------------------

export interface ParsedCalendar {
  id: string;
  summary: string;
  description: string;
  ownerEmail: string;
  timezone: string;
  primary: boolean;
}

export interface ParsedAttendee {
  email: string;
  displayName: string;
  responseStatus: WireResponseStatus;
}

export interface ParsedEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  timezone: string;
  recurrence: string[];
  organizerEmail: string;
  attendees: ParsedAttendee[];
}

export interface ParsedSeed {
  nowMs: number;
  ownerEmail: string;
  ownerName: string;
  /** The world's zone — the fallback for floating times an agent sends later. */
  timezone: string;
  businessName: string;
  promoteToSnapshot: boolean;
  calendars: ParsedCalendar[];
  events: ParsedEvent[];
}
