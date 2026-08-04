import { describe, it, expect } from "vitest";
import { makeTestDb, CORPUS, PRIMARY_ID, TEAM_ID, TZ, OWNER, at, utcMidnight } from "./helpers";
import { getEventRow, listAttendees, insertEvent } from "@/lib/store/events";
import { listCalendarRows } from "@/lib/store/calendars";
import { shapeEvent, shapeCalendarListEntry, parseEventDateTime } from "@/lib/calendar/shape";
import { formatRfc3339, parseRfc3339, tzOffsetMinutes } from "@/lib/calendar/time";
import { buildInsertInput, buildUpdate } from "@/lib/calendar/event-input";
import { CalendarError } from "@/lib/calendar/errors";

const ctx = { calendarId: PRIMARY_ID, calendarTimeZone: TZ, ownerEmail: OWNER, now: at(0, 8) };

describe("time", () => {
  it("formats with the zone's real offset, not UTC", () => {
    expect(formatRfc3339(at(1, 14), TZ)).toBe("2026-07-28T14:00:00-04:00");
    expect(tzOffsetMinutes(at(1, 14), TZ)).toBe(-240);
  });

  it("uses Z when the offset is zero", () => {
    expect(formatRfc3339(Date.UTC(2026, 6, 28, 18), "UTC")).toBe("2026-07-28T18:00:00Z");
  });

  it("round-trips an offset timestamp", () => {
    const ms = at(1, 14);
    expect(parseRfc3339(formatRfc3339(ms, TZ))).toBe(ms);
  });

  it("resolves a floating timestamp in the supplied zone", () => {
    expect(parseRfc3339("2026-07-28T14:00:00", TZ)).toBe(at(1, 14));
  });
});

describe("shapeEvent", () => {
  it("emits a Google-shaped timed event", () => {
    const db = makeTestDb(CORPUS);
    const row = getEventRow(db, PRIMARY_ID, "qbr00001")!;
    const event = shapeEvent(row, listAttendees(db, row.id), {
      ownerEmail: OWNER,
      calendarTimeZone: TZ,
    });
    expect(event.kind).toBe("calendar#event");
    expect(event.id).toBe("qbr00001");
    expect(event.status).toBe("confirmed");
    expect(event.start).toEqual({ dateTime: "2026-07-28T14:00:00-04:00", timeZone: TZ });
    expect(event.end).toEqual({ dateTime: "2026-07-28T15:30:00-04:00", timeZone: TZ });
    expect(event.iCalUID).toBe("qbr00001@google.com");
    expect(event.organizer).toEqual({ email: "priya@acme.co" });
    expect(event.reminders).toEqual({ useDefault: true });
    expect(event.etag).toMatch(/^"\d+"$/);
  });

  it("emits {date} bounds for an all-day event, with no timeZone", () => {
    const db = makeTestDb(CORPUS);
    const row = getEventRow(db, TEAM_ID, "ooo00001")!;
    const event = shapeEvent(row, [], { ownerEmail: OWNER, calendarTimeZone: TZ });
    expect(event.start).toEqual({ date: "2026-07-29" });
    expect(event.end).toEqual({ date: "2026-07-30" });
  });

  it("marks the owner with self and the organizer with organizer", () => {
    const db = makeTestDb(CORPUS);
    const row = getEventRow(db, PRIMARY_ID, "standup1")!;
    const event = shapeEvent(row, listAttendees(db, row.id), {
      ownerEmail: OWNER,
      calendarTimeZone: TZ,
    });
    expect(event.attendees).toEqual([
      { email: OWNER, responseStatus: "accepted", self: true },
      {
        email: "priya@acme.co",
        displayName: "Priya Nair",
        responseStatus: "accepted",
        organizer: true,
      },
    ]);
    expect(event.organizer).toEqual({ email: "priya@acme.co" });
    expect(event.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"]);
  });

  it("swaps the rule for recurringEventId + originalStartTime on an instance", () => {
    const db = makeTestDb(CORPUS);
    const row = getEventRow(db, PRIMARY_ID, "standup1")!;
    const event = shapeEvent(row, [], {
      ownerEmail: OWNER,
      calendarTimeZone: TZ,
      instance: {
        id: "standup1_20260728T133000Z",
        startMs: at(1, 9, 30),
        endMs: at(1, 9, 45),
        originalStartMs: at(1, 9, 30),
      },
    });
    expect(event.id).toBe("standup1_20260728T133000Z");
    expect(event.recurringEventId).toBe("standup1");
    expect(event.recurrence).toBeUndefined();
    expect(event.originalStartTime).toEqual({
      dateTime: "2026-07-28T09:30:00-04:00",
      timeZone: TZ,
    });
  });

  it("round-trips passthrough fields it does not model", () => {
    const db = makeTestDb(CORPUS);
    const row = getEventRow(db, PRIMARY_ID, "focus001")!;
    const event = shapeEvent(row, [], { ownerEmail: OWNER, calendarTimeZone: TZ });
    expect(event.transparency).toBe("transparent");
  });
});

describe("shapeCalendarListEntry", () => {
  it("flags only the primary calendar and never sends primary:false", () => {
    const db = makeTestDb();
    const [primary, team] = listCalendarRows(db).map(shapeCalendarListEntry);
    expect(primary.primary).toBe(true);
    expect(primary.backgroundColor).toBe("#9fe1e7");
    expect(primary.accessRole).toBe("owner");
    expect("primary" in team).toBe(false);
    expect(team.defaultReminders).toEqual([]);
  });
});

describe("parseEventDateTime", () => {
  it("accepts both halves of Google's bound shape", () => {
    expect(parseEventDateTime({ date: "2026-07-29" }, TZ)).toEqual({
      ms: utcMidnight(2),
      allDay: true,
      timeZone: null,
    });
    expect(parseEventDateTime({ dateTime: "2026-07-28T14:00:00-04:00" }, TZ)?.ms).toBe(at(1, 14));
  });

  it("returns null when neither field is present", () => {
    expect(parseEventDateTime({}, TZ)).toBeNull();
    expect(parseEventDateTime(null, TZ)).toBeNull();
  });
});

describe("event input validation", () => {
  it("400s with Google's wording when a bound is missing", () => {
    expect(() => buildInsertInput({ end: { dateTime: "2026-07-28T15:00:00Z" } }, ctx)).toThrowError(
      "Missing start time.",
    );
    expect(() =>
      buildInsertInput({ start: { dateTime: "2026-07-28T15:00:00Z" } }, ctx),
    ).toThrowError("Missing end time.");
  });

  it("rejects a date paired with a dateTime", () => {
    expect(() =>
      buildInsertInput({ start: { date: "2026-07-28" }, end: { dateTime: "2026-07-28T15:00:00Z" } }, ctx),
    ).toThrowError(/both be dates or both be date-times/);
  });

  it("rejects an end before the start", () => {
    expect(() =>
      buildInsertInput(
        { start: { dateTime: "2026-07-28T15:00:00Z" }, end: { dateTime: "2026-07-28T14:00:00Z" } },
        ctx,
      ),
    ).toThrowError(/must not be before its start time/);
  });

  it("rejects an unknown time zone with a 400", () => {
    try {
      buildInsertInput(
        {
          start: { dateTime: "2026-07-28T15:00:00", timeZone: "Mars/Olympus" },
          end: { dateTime: "2026-07-28T16:00:00", timeZone: "Mars/Olympus" },
        },
        ctx,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CalendarError);
      expect((err as CalendarError).code).toBe(400);
    }
  });

  it("PATCH moves the start and keeps the stored duration bound intact", () => {
    const db = makeTestDb(CORPUS);
    const existing = getEventRow(db, PRIMARY_ID, "qbr00001")!;
    const update = buildUpdate(
      { start: { dateTime: "2026-07-28T16:00:00-04:00" }, end: { dateTime: "2026-07-28T17:30:00-04:00" } },
      existing,
      ctx,
      "patch",
    );
    expect(update.startMs).toBe(at(1, 16));
    expect(update.summary).toBeUndefined();
  });

  it("PUT clears fields the caller omitted", () => {
    const db = makeTestDb(CORPUS);
    const existing = getEventRow(db, PRIMARY_ID, "qbr00001")!;
    const update = buildUpdate(
      {
        summary: "Renamed",
        start: { dateTime: "2026-07-28T14:00:00-04:00" },
        end: { dateTime: "2026-07-28T15:00:00-04:00" },
      },
      existing,
      ctx,
      "update",
    );
    expect(update.summary).toBe("Renamed");
    expect(update.description).toBeNull();
    expect(update.attendees).toEqual([]);
  });

  it("keeps a recurrence rule verbatim even when it cannot be expanded", () => {
    const db = makeTestDb();
    const input = buildInsertInput(
      {
        summary: "Monthly board sync",
        start: { dateTime: "2026-07-28T14:00:00-04:00" },
        end: { dateTime: "2026-07-28T15:00:00-04:00" },
        recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=28"],
      },
      ctx,
    );
    const row = insertEvent(db, input);
    const event = shapeEvent(row, [], { ownerEmail: OWNER, calendarTimeZone: TZ });
    expect(event.recurrence).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=28"]);
  });
});
