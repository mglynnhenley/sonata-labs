import { afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { insertCalendar } from "@/lib/store/calendars";
import { insertEvent, type AttendeeInput } from "@/lib/store/events";
import { setMeta } from "@/lib/store/meta";
import { AUDIT_DDL } from "@/lib/db";
import { zonedWallTimeToMs } from "@/lib/calendar/time";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

export const TZ = "America/New_York";
export const OWNER = "sandbox.user@gmail.com";
export const PRIMARY_ID = OWNER;
export const TEAM_ID = "acme.co_engineering@group.calendar.google.com";

// Anchor: Monday 2026-07-27, the same week the seed uses.
export const MONDAY = { year: 2026, month: 7, day: 27 };

/** Wall-clock time in TZ on the anchor Monday + dayOffset. */
export function at(dayOffset: number, hour: number, minute = 0): number {
  return zonedWallTimeToMs(
    MONDAY.year,
    MONDAY.month,
    MONDAY.day + dayOffset,
    hour,
    minute,
    0,
    TZ,
  );
}

export function utcMidnight(dayOffset: number): number {
  return Date.UTC(MONDAY.year, MONDAY.month - 1, MONDAY.day + dayOffset);
}

export interface TestEvent {
  id: string;
  calendarId?: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay?: boolean;
  status?: string;
  recurrence?: string[];
  organizer?: string;
  attendees?: AttendeeInput[];
  extra?: Record<string, unknown>;
}

export function makeTestDb(events: TestEvent[] = []): Database.Database {
  const db = trackDb(new Database(":memory:"));
  db.exec(schema);
  // Mirror production's ATTACHed audit.db so mutation code paths that log can
  // run unchanged under test.
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);
  setMeta(db, "owner_email", OWNER);
  setMeta(db, "default_time_zone", TZ);

  insertCalendar(db, {
    id: PRIMARY_ID,
    summary: "Sandbox User",
    timeZone: TZ,
    isPrimary: true,
    color: { colorId: "14", backgroundColor: "#9fe1e7", foregroundColor: "#000000" },
  });
  insertCalendar(db, {
    id: TEAM_ID,
    summary: "Acme Engineering",
    timeZone: TZ,
    accessRole: "writer",
  });

  for (const e of events) {
    insertEvent(db, {
      id: e.id,
      calendarId: e.calendarId ?? PRIMARY_ID,
      status: e.status,
      summary: e.summary ?? null,
      description: e.description ?? null,
      location: e.location ?? null,
      startMs: e.startMs,
      endMs: e.endMs,
      allDay: e.allDay ?? false,
      startTz: e.allDay ? null : TZ,
      endTz: e.allDay ? null : TZ,
      recurrence: e.recurrence ?? null,
      organizerEmail: e.organizer ?? OWNER,
      createdMs: at(-7, 9),
      updatedMs: at(-7, 9),
      extra: e.extra,
      attendees: e.attendees,
    });
  }
  return db;
}

/** A small fixed corpus reused across the query tests. */
export const CORPUS: TestEvent[] = [
  {
    id: "standup1",
    summary: "Engineering standup",
    location: "Atlas (6)",
    startMs: at(0, 9, 30),
    endMs: at(0, 9, 45),
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"],
    organizer: "priya@acme.co",
    attendees: [
      { email: OWNER, responseStatus: "accepted" },
      { email: "priya@acme.co", displayName: "Priya Nair", responseStatus: "accepted" },
    ],
  },
  {
    id: "qbr00001",
    summary: "Quarterly business review",
    description: "Q3 numbers and audit readiness",
    startMs: at(1, 14),
    endMs: at(1, 15, 30),
    organizer: "priya@acme.co",
  },
  {
    id: "north001",
    summary: "Northwind escalation call",
    startMs: at(1, 14, 30),
    endMs: at(1, 15, 30),
    attendees: [{ email: "ops@northwind.example", responseStatus: "needsAction" }],
  },
  {
    id: "focus001",
    summary: "Focus block",
    startMs: at(2, 9),
    endMs: at(2, 11),
    extra: { transparency: "transparent" },
  },
  {
    id: "declin01",
    summary: "All-hands rehearsal",
    startMs: at(2, 15),
    endMs: at(2, 16),
    organizer: "dan@acme.co",
    attendees: [{ email: OWNER, responseStatus: "declined" }],
  },
  {
    id: "ooo00001",
    calendarId: TEAM_ID,
    summary: "Priya — out of office",
    startMs: utcMidnight(2),
    endMs: utcMidnight(3),
    allDay: true,
    organizer: "priya@acme.co",
  },
];

// Every SQLite handle a test opens is closed when its FILE ends.
//
// better-sqlite3 is a native addon: a handle left to the garbage collector is
// finalized during worker teardown, and if Node has already torn the
// environment down the destructor trips `Assertion failed: (env) != nullptr`
// and kills the worker. Every test passes and the run still exits 1, which is
// the worst possible way for this to present. Registering the hook here means a
// file gets the cleanup simply by importing the fixtures it was going to import
// anyway. It is afterAll and not afterEach because several suites open one
// database per file and share it across their cases.
const openHandles = new Set<Database.Database>();

/** Track a handle a test opened directly, so it is closed with the rest. */
export function trackDb<T extends Database.Database>(db: T): T {
  openHandles.add(db);
  return db;
}

afterAll(() => {
  for (const db of openHandles) {
    try {
      db.close();
    } catch {
      // Already closed by the test, or by a reset that swapped the file. Either
      // way there is nothing left to release.
    }
  }
  openHandles.clear();
});
