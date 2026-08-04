import { describe, it, expect } from "vitest";
import { makeTestDb, CORPUS, PRIMARY_ID, TEAM_ID, TZ, OWNER, at } from "./helpers";
import { listEventRows, cancelEvent } from "@/lib/store/events";
import { listEventResources } from "@/lib/calendar/list";
import { getCalendarRow } from "@/lib/store/calendars";
import { buildWeekView } from "@/lib/ui/views";
import { clampMaxResults, decodePageToken, encodePageToken } from "@/lib/calendar/pagination";
import { seedDatabase } from "@/lib/seed";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

function primary(db: ReturnType<typeof makeTestDb>) {
  return getCalendarRow(db, PRIMARY_ID)!;
}

describe("time-window queries", () => {
  it("returns only events overlapping the window", () => {
    const db = makeTestDb(CORPUS);
    const rows = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(1, 0),
      timeMaxMs: at(2, 0),
    });
    expect(rows.map((r) => r.id)).toEqual(["qbr00001", "north001"]);
  });

  it("counts an event that straddles the window boundary", () => {
    const db = makeTestDb(CORPUS);
    const rows = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(1, 15),
      timeMaxMs: at(1, 15, 15),
    });
    expect(rows.map((r) => r.id)).toEqual(["qbr00001", "north001"]);
  });

  it("pulls in a recurring master whose stored end is outside the window", () => {
    const db = makeTestDb(CORPUS);
    const plain = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(3, 0),
      timeMaxMs: at(4, 0),
    });
    expect(plain).toEqual([]);
    const withMasters = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(3, 0),
      timeMaxMs: at(4, 0),
      includeRecurringMasters: true,
    });
    expect(withMasters.map((r) => r.id)).toEqual(["standup1"]);
  });

  it("hides cancelled events unless showDeleted is set", () => {
    const db = makeTestDb(CORPUS);
    cancelEvent(db, PRIMARY_ID, "qbr00001", at(1, 16));
    const hidden = listEventRows(db, { calendarId: PRIMARY_ID, timeMinMs: at(1, 0), timeMaxMs: at(2, 0) });
    expect(hidden.map((r) => r.id)).toEqual(["north001"]);
    const shown = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(1, 0),
      timeMaxMs: at(2, 0),
      showDeleted: true,
    });
    expect(shown.map((r) => r.id)).toEqual(["qbr00001", "north001"]);
  });

  it("matches q against summary, description, location and attendees", () => {
    const db = makeTestDb(CORPUS);
    const bySummary = listEventRows(db, { calendarId: PRIMARY_ID, q: "northwind" });
    expect(bySummary.map((r) => r.id)).toEqual(["north001"]);
    const byDescription = listEventRows(db, { calendarId: PRIMARY_ID, q: "audit readiness" });
    expect(byDescription.map((r) => r.id)).toEqual(["qbr00001"]);
    const byLocation = listEventRows(db, { calendarId: PRIMARY_ID, q: "Atlas" });
    expect(byLocation.map((r) => r.id)).toEqual(["standup1"]);
    const byAttendee = listEventRows(db, { calendarId: PRIMARY_ID, q: "priya@acme.co" });
    expect(byAttendee.map((r) => r.id)).toEqual(["standup1"]);
  });

  it("scopes to one calendar", () => {
    const db = makeTestDb(CORPUS);
    expect(listEventRows(db, { calendarId: TEAM_ID }).map((r) => r.id)).toEqual(["ooo00001"]);
  });
});

describe("listEventResources", () => {
  it("returns masters with their rule when singleEvents is off", () => {
    const db = makeTestDb(CORPUS);
    const { items } = listEventResources(db, {
      calendar: primary(db),
      ownerEmail: OWNER,
      timeMinMs: at(0, 0),
      timeMaxMs: at(1, 0),
    });
    expect(items.map((i) => i.id)).toEqual(["standup1"]);
    expect(items[0].recurrence).toBeDefined();
  });

  it("expands to instances when singleEvents is on", () => {
    const db = makeTestDb(CORPUS);
    const { items } = listEventResources(db, {
      calendar: primary(db),
      ownerEmail: OWNER,
      timeMinMs: at(0, 0),
      timeMaxMs: at(3, 0),
      singleEvents: true,
    });
    expect(items.map((i) => i.id)).toEqual([
      "standup1_20260727T133000Z",
      "standup1_20260728T133000Z",
      "qbr00001",
      "north001",
      "focus001",
      "standup1_20260729T133000Z",
      "declin01",
    ]);
    expect(items[0].recurringEventId).toBe("standup1");
  });
});

describe("pagination", () => {
  it("round-trips an opaque page token", () => {
    expect(decodePageToken(encodePageToken({ offset: 40 }))).toEqual({ offset: 40 });
  });

  it("treats a garbage token as the first page", () => {
    expect(decodePageToken("not-a-token")).toEqual({ offset: 0 });
  });

  it("clamps maxResults to Calendar's bounds", () => {
    expect(clampMaxResults(null)).toBe(250);
    expect(clampMaxResults("10")).toBe(10);
    expect(clampMaxResults("99999")).toBe(2500);
    expect(clampMaxResults("-3")).toBe(250);
  });
});

describe("week view", () => {
  it("flattens every calendar into one sorted grid", () => {
    const db = makeTestDb(CORPUS);
    const view = buildWeekView(db, { windowStartMs: at(2, 0), windowEndMs: at(3, 0) });
    expect(view.events.map((e) => e.summary)).toEqual([
      "Priya — out of office",
      "Focus block",
      "Engineering standup",
      "All-hands rehearsal",
    ]);
    expect(view.events[0].allDay).toBe(true);
    expect(view.events.at(-1)?.declinedByOwner).toBe(true);
    expect(view.calendars.map((c) => c.id)).toEqual([PRIMARY_ID, TEAM_ID]);
  });
});

describe("seed", () => {
  it("builds a world with a conflict the agent has to resolve", () => {
    const db = new Database(":memory:");
    db.exec(schema);
    seedDatabase(db);
    const rows = listEventRows(db, {
      calendarId: "sandbox.user@gmail.com",
      timeMinMs: at(1, 14),
      timeMaxMs: at(1, 15),
    });
    expect(rows.map((r) => r.summary)).toEqual([
      "Quarterly business review",
      "Northwind escalation call",
    ]);
    expect(getCalendarRow(db, "sandbox.user@gmail.com")?.time_zone).toBe(TZ);
  });
});
