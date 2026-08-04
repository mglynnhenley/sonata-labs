import type { Database } from "better-sqlite3";
import { insertCalendar } from "./store/calendars";
import { insertEvent, type AttendeeInput } from "./store/events";
import { setMeta } from "./store/meta";
import { zonedWallTimeToMs } from "./calendar/time";

// Synthetic calendar so the API/UI can be developed and verified without a real
// Google account. Deliberately shares people and domains with the Gmail twin's
// seed (sandbox.user@gmail.com, priya@acme.co) so a cloned business is coherent
// across both — the same person's 1:1 shows up in both worlds.

const OWNER_EMAIL = "sandbox.user@gmail.com";
const OWNER_NAME = "Sandbox User";
const TZ = "America/New_York";

// Anchor to a fixed week so seeds are reproducible run-to-run. Mon 2026-07-27.
const WEEK_MONDAY = { year: 2026, month: 7, day: 27 };

const PRIMARY_ID = OWNER_EMAIL;
const TEAM_ID = "acme.co_engineering@group.calendar.google.com";
const ROOM_ID = "acme.co_atlas6@resource.calendar.google.com";

const PEOPLE: Record<string, string> = {
  [OWNER_EMAIL]: OWNER_NAME,
  "priya@acme.co": "Priya Nair",
  "dan@acme.co": "Dan Okafor",
  "mei@acme.co": "Mei Lin",
  "ops@northwind.example": "Northwind Ops",
  "j.rivera@example.com": "Jordan Rivera",
};

interface SeedEvent {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  /** Weekday offset from the anchor Monday. */
  dayOffset: number;
  /** Local wall-clock start/end in TZ. Omit for an all-day event. */
  startHour?: number;
  startMinute?: number;
  durationMinutes?: number;
  /** All-day events span whole days from dayOffset. */
  allDayDays?: number;
  recurrence?: string[];
  organizer?: string;
  attendees?: Array<{ email: string; responseStatus?: string; optional?: boolean }>;
  extra?: Record<string, unknown>;
}

const SEED_EVENTS: SeedEvent[] = [
  {
    calendarId: PRIMARY_ID,
    summary: "Engineering standup",
    description: "Fifteen minutes. Blockers only — take the rest to the channel.",
    location: "Atlas (6)",
    dayOffset: 0,
    startHour: 9,
    startMinute: 30,
    durationMinutes: 15,
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20"],
    organizer: "priya@acme.co",
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "accepted" },
      { email: "priya@acme.co", responseStatus: "accepted" },
      { email: "dan@acme.co", responseStatus: "accepted" },
      { email: "mei@acme.co", responseStatus: "accepted" },
    ],
  },
  {
    calendarId: PRIMARY_ID,
    summary: "1:1 — Priya / Sandbox",
    description: "Standing weekly. Agenda doc in the invite.",
    dayOffset: 1,
    startHour: 11,
    durationMinutes: 30,
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=12"],
    organizer: "priya@acme.co",
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "accepted" },
      { email: "priya@acme.co", responseStatus: "accepted" },
    ],
  },
  {
    calendarId: PRIMARY_ID,
    summary: "Quarterly business review",
    description: "Q3 numbers, headcount plan, audit readiness.",
    location: "Atlas (6)",
    dayOffset: 1,
    startHour: 14,
    durationMinutes: 90,
    organizer: "priya@acme.co",
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "accepted" },
      { email: "priya@acme.co", responseStatus: "accepted" },
      { email: "dan@acme.co", responseStatus: "tentative" },
    ],
  },
  {
    // Deliberate double-book against the QBR — the escalation scenario needs a
    // conflict the agent has to notice and resolve.
    calendarId: PRIMARY_ID,
    summary: "Northwind escalation call",
    description: "Client asked for time today. Payments failing since the release.",
    location: "https://meet.example.com/northwind-sync",
    dayOffset: 1,
    startHour: 14,
    startMinute: 30,
    durationMinutes: 60,
    organizer: OWNER_EMAIL,
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "accepted" },
      { email: "ops@northwind.example", responseStatus: "needsAction" },
    ],
  },
  {
    calendarId: PRIMARY_ID,
    summary: "Focus block — audit evidence",
    dayOffset: 2,
    startHour: 9,
    durationMinutes: 120,
    organizer: OWNER_EMAIL,
    extra: { transparency: "transparent", colorId: "8" },
  },
  {
    calendarId: PRIMARY_ID,
    summary: "Candidate loop — Jordan Rivera (systems)",
    description: "Panel 3 of 4. Scorecard due same day.",
    location: "Atlas (6)",
    dayOffset: 3,
    startHour: 13,
    durationMinutes: 45,
    organizer: "mei@acme.co",
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "needsAction" },
      { email: "mei@acme.co", responseStatus: "accepted" },
      { email: "j.rivera@example.com", responseStatus: "accepted" },
      { email: "dan@acme.co", responseStatus: "needsAction", optional: true },
    ],
  },
  {
    calendarId: PRIMARY_ID,
    summary: "Flight AC742 — JFK → SFO",
    description: "Departs 07:05, gate closes 06:35.",
    location: "JFK Terminal 4",
    dayOffset: 4,
    startHour: 7,
    startMinute: 5,
    durationMinutes: 380,
    organizer: OWNER_EMAIL,
    extra: { colorId: "5" },
  },
  {
    calendarId: PRIMARY_ID,
    summary: "Declined: All-hands rehearsal",
    dayOffset: 2,
    startHour: 15,
    durationMinutes: 60,
    organizer: "dan@acme.co",
    attendees: [
      { email: OWNER_EMAIL, responseStatus: "declined" },
      { email: "dan@acme.co", responseStatus: "accepted" },
    ],
  },
  {
    calendarId: TEAM_ID,
    summary: "Priya — out of office",
    dayOffset: 2,
    allDayDays: 1,
    organizer: "priya@acme.co",
  },
  {
    calendarId: TEAM_ID,
    summary: "Release freeze",
    description: "No deploys until the audit walkthrough clears.",
    dayOffset: 3,
    allDayDays: 2,
    organizer: "dan@acme.co",
  },
  {
    calendarId: ROOM_ID,
    summary: "Atlas (6) — Engineering standup",
    dayOffset: 0,
    startHour: 9,
    startMinute: 30,
    durationMinutes: 15,
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=20"],
    organizer: "priya@acme.co",
  },
  {
    calendarId: ROOM_ID,
    summary: "Atlas (6) — Quarterly business review",
    dayOffset: 1,
    startHour: 14,
    durationMinutes: 90,
    organizer: "priya@acme.co",
  },
];

function localMs(dayOffset: number, hour: number, minute: number): number {
  return zonedWallTimeToMs(
    WEEK_MONDAY.year,
    WEEK_MONDAY.month,
    WEEK_MONDAY.day + dayOffset,
    hour,
    minute,
    0,
    TZ,
  );
}

function utcMidnight(dayOffset: number): number {
  return Date.UTC(WEEK_MONDAY.year, WEEK_MONDAY.month - 1, WEEK_MONDAY.day + dayOffset);
}

/** Populate an empty (schema-applied) database with the synthetic world. */
export function seedDatabase(db: Database): void {
  setMeta(db, "owner_email", OWNER_EMAIL);
  setMeta(db, "owner_name", OWNER_NAME);
  setMeta(db, "default_time_zone", TZ);
  setMeta(db, "seeded_at", String(localMs(0, 0, 0)));

  insertCalendar(db, {
    id: PRIMARY_ID,
    summary: OWNER_NAME,
    description: "Primary calendar",
    timeZone: TZ,
    isPrimary: true,
    accessRole: "owner",
    color: { colorId: "14", backgroundColor: "#9fe1e7", foregroundColor: "#000000" },
  });
  insertCalendar(db, {
    id: TEAM_ID,
    summary: "Acme Engineering",
    description: "Team-wide OOO, freezes and launches.",
    timeZone: TZ,
    accessRole: "writer",
    color: { colorId: "10", backgroundColor: "#7bd148", foregroundColor: "#000000" },
  });
  insertCalendar(db, {
    id: ROOM_ID,
    summary: "Atlas (6) — Conference Room",
    description: "Seats 6. Video bar, no whiteboard.",
    timeZone: TZ,
    accessRole: "freeBusyReader",
    color: { colorId: "17", backgroundColor: "#9a9cff", foregroundColor: "#000000" },
  });

  const createdMs = localMs(-7, 9, 0); // authored the week before
  for (const seed of SEED_EVENTS) {
    const allDay = seed.allDayDays !== undefined;
    const startMs = allDay
      ? utcMidnight(seed.dayOffset)
      : localMs(seed.dayOffset, seed.startHour ?? 9, seed.startMinute ?? 0);
    const endMs = allDay
      ? utcMidnight(seed.dayOffset + (seed.allDayDays ?? 1))
      : startMs + (seed.durationMinutes ?? 30) * 60_000;

    const attendees: AttendeeInput[] = (seed.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: PEOPLE[a.email] ?? null,
      responseStatus: a.responseStatus ?? "needsAction",
      optional: a.optional,
    }));

    insertEvent(db, {
      calendarId: seed.calendarId,
      summary: seed.summary,
      description: seed.description ?? null,
      location: seed.location ?? null,
      startMs,
      endMs,
      allDay,
      startTz: allDay ? null : TZ,
      endTz: allDay ? null : TZ,
      recurrence: seed.recurrence ?? null,
      organizerEmail: seed.organizer ?? OWNER_EMAIL,
      createdMs,
      updatedMs: createdMs,
      extra: seed.extra,
      attendees,
    });
  }
}

export const SEED_OWNER_EMAIL = OWNER_EMAIL;
export const SEED_TIME_ZONE = TZ;
export const SEED_PRIMARY_CALENDAR_ID = PRIMARY_ID;
