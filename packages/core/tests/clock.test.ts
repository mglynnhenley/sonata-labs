import { describe, expect, it } from "vitest";
import {
  endISO,
  isoToTick,
  lastTick,
  offsetMinutes,
  tickLabel,
  tickRange,
  tickToISO,
  validateClock,
} from "../src/clock";
import type { Clock } from "../src/types/episode";

// The clock is the only source of simulated time in the product, so what is
// under test is the contract the whole engine leans on: ticks map to instants
// one way, instants map back the other, and the label a user reads is the
// company's local time on any machine.

const utc: Clock = { startISO: "2026-08-04T09:00:00Z", ticks: 32, simMinutesPerTick: 15 };
const newYork: Clock = { startISO: "2026-08-04T09:00:00-04:00", ticks: 32, simMinutesPerTick: 15 };

describe("tickToISO", () => {
  it("advances by simMinutesPerTick", () => {
    expect(tickToISO(utc, 0)).toBe("2026-08-04T09:00:00.000Z");
    expect(tickToISO(utc, 1)).toBe("2026-08-04T09:15:00.000Z");
    expect(tickToISO(utc, 8)).toBe("2026-08-04T11:00:00.000Z");
  });

  it("normalises an offset start to the same absolute instant", () => {
    expect(tickToISO(newYork, 0)).toBe("2026-08-04T13:00:00.000Z");
  });

  it("allows ticks past the end of the day, because the director schedules ahead", () => {
    expect(tickToISO(utc, 40)).toBe("2026-08-04T19:00:00.000Z");
  });

  it("rejects a start with no UTC offset, which would differ per machine", () => {
    const naive: Clock = { startISO: "2026-08-04T09:00:00", ticks: 4, simMinutesPerTick: 15 };
    expect(() => tickToISO(naive, 0)).toThrow(/no UTC offset/);
  });

  it("rejects a non-positive tick length", () => {
    const stuck: Clock = { startISO: "2026-08-04T09:00:00Z", ticks: 4, simMinutesPerTick: 0 };
    expect(() => tickToISO(stuck, 1)).toThrow(/simMinutesPerTick/);
  });
});

describe("isoToTick", () => {
  it("round-trips every tick of the day", () => {
    for (const t of tickRange(utc)) expect(isoToTick(utc, tickToISO(utc, t))).toBe(t);
  });

  it("floors an instant inside a tick's window onto that tick", () => {
    expect(isoToTick(utc, "2026-08-04T09:14:59Z")).toBe(0);
    expect(isoToTick(utc, "2026-08-04T09:15:00Z")).toBe(1);
  });

  it("goes negative before the day started", () => {
    expect(isoToTick(utc, "2026-08-04T08:50:00Z")).toBe(-1);
  });
});

describe("day boundaries", () => {
  it("ends one tick past the last one", () => {
    expect(lastTick(utc)).toBe(31);
    expect(endISO(utc)).toBe("2026-08-04T17:00:00.000Z");
  });

  it("enumerates 0..ticks-1", () => {
    expect(tickRange({ ...utc, ticks: 3 })).toEqual([0, 1, 2]);
    expect(tickRange({ ...utc, ticks: 0 })).toEqual([]);
  });
});

describe("tickLabel", () => {
  it("reads as the company's own wall clock, not UTC", () => {
    expect(tickLabel(newYork, 0)).toBe("09:00");
    expect(tickLabel(newYork, 5)).toBe("10:15");
    expect(tickLabel(utc, 5)).toBe("10:15");
  });
});

describe("offsetMinutes", () => {
  it("reads Z, +HH:MM and -HHMM", () => {
    expect(offsetMinutes("2026-08-04T09:00:00Z")).toBe(0);
    expect(offsetMinutes("2026-08-04T09:00:00+05:30")).toBe(330);
    expect(offsetMinutes("2026-08-04T09:00:00-0430")).toBe(-270);
  });
});

describe("explicit five-day opportunity clock", () => {
  const week: Clock = {
    startISO: "2026-09-14T09:00:00+01:00", ticks: 180, simMinutesPerTick: 15,
    tickISOs: Array.from({ length: 180 }, (_, tick) =>
      new Date(Date.parse("2026-09-14T09:00:00+01:00") + Math.floor(tick / 36) * 86_400_000 + (tick % 36) * 900_000).toISOString()),
    endISO: "2026-09-18T18:00:00+01:00",
  };

  it("runs Monday through Friday, preserving the final close instead of advancing to Monday", () => {
    expect(tickToISO(week, 35)).toBe("2026-09-14T16:45:00.000Z");
    expect(tickToISO(week, 36)).toBe("2026-09-15T08:00:00.000Z");
    expect(tickToISO(week, 179)).toBe("2026-09-18T16:45:00.000Z");
    expect(endISO(week)).toBe("2026-09-18T17:00:00.000Z");
    expect(tickLabel(week, 36)).toBe("09:00");
    for (const tick of tickRange(week)) expect(isoToTick(week, tickToISO(week, tick))).toBe(tick);
  });

  it("maps off-hours to the previous opportunity; closes and outside scheduling remain explicit", () => {
    expect(isoToTick(week, "2026-09-14T18:00:00+01:00")).toBe(35);
    expect(isoToTick(week, "2026-09-15T08:59:59+01:00")).toBe(35);
    expect(isoToTick(week, week.endISO!)).toBe(180);
    expect(tickToISO(week, 181)).toBe("2026-09-18T17:15:00.000Z");
    expect(isoToTick(week, "2026-09-14T08:59:00+01:00")).toBe(-1);
  });

  it("rejects incomplete schedules, duplicate or reversed instants, first-start drift and premature close", () => {
    const invalid: Clock[] = [
      { ...week, tickISOs: week.tickISOs!.slice(1) },
      { ...week, endISO: undefined },
      { ...week, tickISOs: undefined },
      { ...week, tickISOs: week.tickISOs!.map((iso, index) => index === 1 ? week.tickISOs![0] : iso) },
      { ...week, tickISOs: [...week.tickISOs!].reverse() },
      { ...week, startISO: "2026-09-14T08:00:00+01:00" },
      { ...week, endISO: week.tickISOs![179] },
      { ...week, endISO: "2026-09-18T18:00:00" },
      { ...week, tickISOs: week.tickISOs!.map((iso, index) => index === 4 ? "not a dateZ" : iso) },
    ];
    for (const clock of invalid) expect(() => validateClock(clock)).toThrow();
    expect(() => tickToISO(week, 1.5)).toThrow(/integer/);
  });
});
