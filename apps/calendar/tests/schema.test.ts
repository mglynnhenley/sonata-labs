import { describe, it, expect } from "vitest";
import { makeTestDb, CORPUS, PRIMARY_ID, TEAM_ID, at } from "./helpers";
import { getEventRow, insertEvent, cancelEvent, listAttendees } from "@/lib/store/events";
import { listCalendarRows, resolveCalendar } from "@/lib/store/calendars";
import { logAction, listActions, startNewSession } from "@/lib/audit";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

describe("schema", () => {
  it("creates every table the API reads", () => {
    const db = makeTestDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const table of [
      "meta",
      "calendars",
      "events",
      "event_attendees",
      "sessions",
      "action_log",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("indexes (calendar_id, start_ms) — every window scan depends on it", () => {
    const db = makeTestDb(CORPUS);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM events WHERE calendar_id = ? AND start_ms > ? ORDER BY start_ms",
      )
      .all(PRIMARY_ID, 0) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_events_calendar_start");
  });

  it("cascades attendees when an event is removed", () => {
    const db = makeTestDb(CORPUS);
    expect(listAttendees(db, "standup1")).toHaveLength(2);
    db.prepare("DELETE FROM events WHERE id = ?").run("standup1");
    expect(listAttendees(db, "standup1")).toHaveLength(0);
  });

  it("applies cleanly to a fresh audit-only database", () => {
    const audit = new Database(":memory:");
    audit.exec(schema);
    const names = (
      audit.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("action_log");
  });
});

describe("store", () => {
  it("resolves 'primary' and the owner address to the primary calendar", () => {
    const db = makeTestDb();
    expect(resolveCalendar(db, "primary")?.id).toBe(PRIMARY_ID);
    expect(resolveCalendar(db, PRIMARY_ID.toUpperCase())?.id).toBe(PRIMARY_ID);
    expect(resolveCalendar(db, "nope@example.com")).toBeNull();
  });

  it("orders calendarList with the primary first", () => {
    const db = makeTestDb();
    expect(listCalendarRows(db).map((c) => c.id)).toEqual([PRIMARY_ID, TEAM_ID]);
  });

  it("tombstones on delete and refuses a second delete", () => {
    const db = makeTestDb(CORPUS);
    cancelEvent(db, PRIMARY_ID, "qbr00001", at(1, 16));
    expect(getEventRow(db, PRIMARY_ID, "qbr00001")?.status).toBe("cancelled");
    expect(() => cancelEvent(db, PRIMARY_ID, "qbr00001")).toThrowError(/deleted/i);
  });

  it("generates a base32hex id and an iCalUID when none is supplied", () => {
    const db = makeTestDb();
    const row = insertEvent(db, {
      calendarId: PRIMARY_ID,
      startMs: at(0, 10),
      endMs: at(0, 11),
      allDay: false,
    });
    expect(row.id).toMatch(/^[0-9a-v]{26}$/);
    expect(row.ical_uid).toBe(`${row.id}@google.com`);
  });
});

describe("audit", () => {
  it("writes an action row that a mutation transaction can roll back with", () => {
    const db = makeTestDb(CORPUS);
    startNewSession(db, "test", at(0, 8));
    expect(() =>
      db.transaction(() => {
        logAction(db, {
          method: "POST",
          endpoint: "/calendar/v3/calendars/primary/events",
          actionType: "eventInsert",
          targetType: "event",
          targetId: "abc",
          summary: "Created “Test”",
        });
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(listActions(db)).toHaveLength(0);
  });

  it("keeps the action when the transaction commits", () => {
    const db = makeTestDb(CORPUS);
    startNewSession(db, "test", at(0, 8));
    db.transaction(() => {
      logAction(db, {
        method: "DELETE",
        endpoint: "/calendar/v3/calendars/primary/events/qbr00001",
        actionType: "eventDelete",
        targetType: "event",
        targetId: "qbr00001",
        summary: "Cancelled “Quarterly business review”",
      });
    })();
    const actions = listActions(db);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("eventDelete");
  });
});
