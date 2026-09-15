import { describe, expect, it } from "vitest";
import { episodeTwins } from "@sonata/core";
import { vcBusyDay, vcInvestmentDay } from "@sonata/scenarios";
import { templateById, resolveCalendarSeed } from "@sonata/world";
import { freeWindows } from "@sonata/engine/tools/calendar";

describe("VC busy-day environment", () => {
  const world = templateById("alderbridge-busy-day")!;
  it("uses a separate backlog and exposes Attio as required work", () => {
    expect(world.world).toEqual(vcBusyDay.world);
    expect(world.world.business.name).not.toBe(vcInvestmentDay.world.business.name);
    expect(episodeTwins(vcBusyDay)).toEqual(["gmail", "slack", "calendar", "attio"]);
    expect(world.attio.deals).toHaveLength(3);
    expect(world.attio.tasks).toHaveLength(5);
    expect(new Set(world.attio.deals.map(d => d.name)).size).toBe(3);
  });

  it("has one common afternoon slot across all four personal calendars", () => {
    const seed = resolveCalendarSeed(world.world, world.calendar, Date.parse(vcBusyDay.clock.startISO));
    expect(seed.calendars.map(c => c.id).sort()).toEqual([
      "alex@alderbridge.example", "ben@alderbridge.example", "maya@alderbridge.example", "ruth@alderbridge.example",
    ]);
    const free = freeWindows(seed.events.map(e => ({ start: Date.parse(e.startISO), end: Date.parse(e.endISO) })),
      Date.parse("2026-09-15T13:00:00+01:00"), Date.parse("2026-09-15T16:00:00+01:00"), 30 * 60_000);
    expect(free).toEqual([{ start: Date.parse("2026-09-15T15:00:00+01:00"), end: Date.parse("2026-09-15T15:30:00+01:00") }]);
  });

  it("makes sharing consent available before the deadline and keeps the existing reference evidence private", () => {
    const note = world.attio.notes.find(n => n.title.includes("sharing permission"))!;
    expect(note.about).toBe("LedgerLens");
    expect(note.body).toContain("lena@cedarvc.example");
    expect(note.body).toContain("No permission for Northbank");
    expect(world.attio.notes.find(n => n.about === "CloseKit — seed")!.body).toContain("No external sharing consent");
    expect(world.world.channels.every(c => c.isPrivate)).toBe(true);
  });
});
