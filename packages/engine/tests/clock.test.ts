import { describe, it, expect } from "vitest";
import type { Clock } from "@sonata/core";
import { createClock } from "../src/clock";

// The clock is the one thing every other part of the engine reads time from, so
// these assertions are all about the same property: given the same spec, the same
// answers, on any machine, at any wall-clock moment.

const utc: Clock = { startISO: "2026-08-04T09:00:00Z", ticks: 32, simMinutesPerTick: 15 };
const paris: Clock = { startISO: "2026-08-04T09:00:00+02:00", ticks: 8, simMinutesPerTick: 30 };

describe("createClock", () => {
  it("converts ticks to instants and labels the day in the spec's own offset", () => {
    const clock = createClock(utc);
    expect(clock.isoAt(0)).toBe("2026-08-04T09:00:00.000Z");
    expect(clock.isoAt(5)).toBe("2026-08-04T10:15:00.000Z");
    expect(clock.labelAt(0)).toBe("09:00");
    expect(clock.labelAt(5)).toBe("10:15");

    // 09:00 in Paris is 07:00 UTC, and the label still reads 09:00 — the whole
    // point of carrying the offset on the spec rather than on the machine.
    const p = createClock(paris);
    expect(p.isoAt(0)).toBe("2026-08-04T07:00:00.000Z");
    expect(p.labelAt(2)).toBe("10:00");
  });

  it("never consults the wall clock", () => {
    const before = createClock(utc).isoAt(3);
    const spy = Date.now;
    // Any read of Date.now() inside a conversion would be caught here: the value
    // it would produce is thirty years off.
    Date.now = () => 0;
    try {
      expect(createClock(utc).isoAt(3)).toBe(before);
      expect(createClock(utc).labelAt(3)).toBe("09:45");
    } finally {
      Date.now = spy;
    }
  });

  it("rejects a start with no offset at construction, not mid-run", () => {
    expect(() => createClock({ ...utc, startISO: "2026-08-04T09:00:00" })).toThrow(/offset/);
    expect(() => createClock({ ...utc, simMinutesPerTick: 0 })).toThrow(/positive/);
  });

  it("floors an instant into the tick that contains it", () => {
    const clock = createClock(utc);
    expect(clock.tickAt("2026-08-04T09:00:00Z")).toBe(0);
    expect(clock.tickAt("2026-08-04T09:14:59Z")).toBe(0);
    expect(clock.tickAt("2026-08-04T09:15:00Z")).toBe(1);
    // Before the day began is negative, not clamped: the caller decides.
    expect(clock.tickAt("2026-08-04T08:00:00Z")).toBe(-4);
  });

  it("knows where the day starts and stops", () => {
    const clock = createClock(utc);
    expect(clock.last()).toBe(31);
    expect(clock.contains(0)).toBe(true);
    expect(clock.contains(31)).toBe(true);
    expect(clock.contains(32)).toBe(false);
    expect(clock.contains(-1)).toBe(false);
    expect(clock.contains(1.5)).toBe(false);
    // Exclusive: the end is the instant after the last tick's window.
    expect(clock.end()).toBe("2026-08-04T17:00:00.000Z");
    expect(clock.all()).toHaveLength(32);
    expect(clock.all()[31]).toBe(31);
  });

  it("clamps ranges to the day and returns nothing when inverted", () => {
    const clock = createClock(utc);
    expect(clock.range(-5, 2)).toEqual([0, 1, 2]);
    expect(clock.range(30, 99)).toEqual([30, 31]);
    expect(clock.range(5, 4)).toEqual([]);
  });

  it("treats a window as half-open, so a boundary instant fires once", () => {
    const clock = createClock(utc);
    // [09:00, 09:30) is ticks 0 and 1 — the tick starting at 09:30 belongs to the
    // next window, or every boundary beat would fire twice.
    expect(clock.between("2026-08-04T09:00:00Z", "2026-08-04T09:30:00Z")).toEqual([0, 1]);
    expect(clock.between("2026-08-04T09:30:00Z", "2026-08-04T10:00:00Z")).toEqual([2, 3]);
    // A range starting mid-tick does not re-fire the tick it started in.
    expect(clock.between("2026-08-04T09:07:00Z", "2026-08-04T09:45:00Z")).toEqual([1, 2]);
  });

  it("compares boundaries as instants, not as strings", () => {
    const clock = createClock(paris);
    // "09:00+02:00" is tick 0's exact start, written in a form tickToISO never
    // renders. A string match here would silently drop tick 0.
    expect(clock.between("2026-08-04T09:00:00+02:00", "2026-08-04T10:00:00+02:00")).toEqual([0, 1]);
  });

  it("measures elapsed simulated minutes, signed", () => {
    const clock = createClock(utc);
    expect(clock.minutesBetween(0, 4)).toBe(60);
    expect(clock.minutesBetween(4, 0)).toBe(-60);
    expect(createClock(paris).minutesBetween(0, 2)).toBe(60);
  });

  it("labels a tick's whole window for the timeline header", () => {
    expect(createClock(utc).windowLabel(1)).toBe("09:15–09:30");
    // The last window is allowed to name the instant the day ends.
    expect(createClock(utc).windowLabel(31)).toBe("16:45–17:00");
  });
});
