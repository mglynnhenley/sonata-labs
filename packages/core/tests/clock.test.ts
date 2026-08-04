import { describe, expect, it } from "vitest";
import {
  endISO,
  isoToTick,
  lastTick,
  offsetMinutes,
  tickLabel,
  tickRange,
  tickToISO,
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
