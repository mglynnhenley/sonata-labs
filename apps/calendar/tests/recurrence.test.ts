import { describe, it, expect } from "vitest";
import { expandRecurrence, parseRrule, parseExdates, expandEventRows } from "@/lib/calendar/recurrence";
import { makeTestDb, CORPUS, PRIMARY_ID, TZ, at } from "./helpers";
import { listEventRows } from "@/lib/store/events";
import { formatRfc3339 } from "@/lib/calendar/time";

const HOUR = 3600_000;

describe("parseRrule", () => {
  it("reads FREQ, INTERVAL, COUNT and BYDAY", () => {
    const rule = parseRrule("RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,TH");
    expect(rule).toMatchObject({ freq: "WEEKLY", interval: 2, count: 4, byDay: ["TU", "TH"] });
  });

  it("reads UNTIL in iCalendar basic format", () => {
    const rule = parseRrule("RRULE:FREQ=DAILY;UNTIL=20260731T235959Z");
    expect(rule?.untilMs).toBe(Date.UTC(2026, 6, 31, 23, 59, 59));
  });

  it("returns null for the frequencies we deliberately do not expand", () => {
    expect(parseRrule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15")).toBeNull();
    expect(parseRrule("RRULE:FREQ=YEARLY")).toBeNull();
  });

  it("drops a numbered BYDAY rather than treating 2MO as every Monday", () => {
    expect(parseRrule("RRULE:FREQ=WEEKLY;BYDAY=2MO")?.byDay).toEqual([]);
  });
});

describe("expandRecurrence", () => {
  const base = {
    startMs: at(0, 9, 30),
    endMs: at(0, 9, 45),
    allDay: false,
    timeZone: TZ,
  };

  it("expands a weekday standup across one week", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"],
      windowStartMs: at(0, 0),
      windowEndMs: at(5, 0),
    });
    expect(out.map((o) => o.startMs)).toEqual([
      at(0, 9, 30),
      at(1, 9, 30),
      at(2, 9, 30),
      at(3, 9, 30),
      at(4, 9, 30),
    ]);
    expect(out.every((o) => o.endMs - o.startMs === 15 * 60_000)).toBe(true);
  });

  it("honours COUNT across the whole series, not per window", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      windowStartMs: at(0, 0),
      windowEndMs: at(30, 0),
    });
    expect(out).toHaveLength(3);
    expect(out[2].startMs).toBe(at(2, 9, 30));
  });

  it("honours UNTIL", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=DAILY;UNTIL=20260729T235959Z"],
      windowStartMs: at(0, 0),
      windowEndMs: at(30, 0),
    });
    expect(out).toHaveLength(3);
  });

  it("respects INTERVAL on a fortnightly series", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3"],
      windowStartMs: at(0, 0),
      windowEndMs: at(60, 0),
    });
    expect(out.map((o) => o.startMs)).toEqual([at(0, 9, 30), at(14, 9, 30), at(28, 9, 30)]);
  });

  it("skips EXDATE occurrences but still counts them toward COUNT", () => {
    const exdate = new Date(at(1, 9, 30)).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3", `EXDATE:${exdate}`],
      windowStartMs: at(0, 0),
      windowEndMs: at(30, 0),
    });
    expect(out.map((o) => o.startMs)).toEqual([at(0, 9, 30), at(2, 9, 30)]);
  });

  it("only returns occurrences overlapping the window", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=DAILY;COUNT=10"],
      windowStartMs: at(3, 0),
      windowEndMs: at(5, 0),
    });
    expect(out.map((o) => o.startMs)).toEqual([at(3, 9, 30), at(4, 9, 30)]);
  });

  it("holds the wall clock across a DST boundary", () => {
    // 2026-10-25 is the last Sunday of BST; New York changes on 2026-11-01.
    const start = Date.UTC(2026, 9, 29, 13, 0); // 09:00 EDT
    const out = expandRecurrence({
      startMs: start,
      endMs: start + HOUR,
      allDay: false,
      timeZone: TZ,
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=2"],
      windowStartMs: start,
      windowEndMs: start + 30 * 24 * HOUR,
    });
    expect(formatRfc3339(out[0].startMs, TZ)).toBe("2026-10-29T09:00:00-04:00");
    expect(formatRfc3339(out[1].startMs, TZ)).toBe("2026-11-05T09:00:00-05:00");
    // 8 days of real time between them, not 7 — the clock, not the duration, is held.
    expect(out[1].startMs - out[0].startMs).toBe(7 * 24 * HOUR + HOUR);
  });

  it("returns the master alone for a rule it cannot expand", () => {
    const out = expandRecurrence({
      ...base,
      recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=27"],
      windowStartMs: at(0, 0),
      windowEndMs: at(60, 0),
    });
    expect(out).toEqual([{ startMs: base.startMs, endMs: base.endMs, originalStartMs: base.startMs }]);
  });
});

describe("parseExdates", () => {
  it("reads TZID-qualified and comma-separated values", () => {
    const set = parseExdates(["EXDATE;TZID=America/New_York:20260728T093000,20260729T093000"], TZ);
    expect(set.has(at(1, 9, 30))).toBe(true);
    expect(set.has(at(2, 9, 30))).toBe(true);
  });
});

describe("expandEventRows", () => {
  it("interleaves instances and plain events in start order with Google's ids", () => {
    const db = makeTestDb(CORPUS);
    const rows = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: at(1, 0),
      timeMaxMs: at(2, 0),
      includeRecurringMasters: true,
    });
    const expanded = expandEventRows(rows, at(1, 0), at(2, 0), TZ);
    expect(expanded.map((e) => e.instanceId ?? e.row.id)).toEqual([
      "standup1_20260728T133000Z",
      "qbr00001",
      "north001",
    ]);
  });
});
