import { describe, expect, it } from "vitest";
import { tickToISO } from "@sonata/core";
import { vcInvestmentDay as spec } from "@sonata/scenarios";
import { templateById } from "@sonata/world";
import { runChecklist } from "@sonata/judge";

const backlog = templateById("alderbridge-ventures")!;

describe("VC pilot evidence and timing", () => {
  it("opens on the same cast and channels that receive the day's events", () => {
    expect(backlog.world).toEqual(spec.world);
    expect(backlog.gmail.threads.every(t => t.participants.includes(spec.world.mailboxOwner))).toBe(true);
  });

  it("leaves the offered 14:00 reference slot free but blocks the offered 16:00 alternative", () => {
    const dayStart = Date.parse(spec.clock.startISO);
    const meetings = [
      ...backlog.calendar.events.map(e => [dayStart + e.startOffsetMin * 60_000, dayStart + (e.startOffsetMin + e.durationMin) * 60_000]),
      ...spec.beats.flatMap(b => b.twin === "calendar" && b.kind === "invite"
        ? [[Date.parse(b.payload.startISO), Date.parse(b.payload.endISO)]] : []),
    ];
    const clashes = (hour: number) => {
      const start = dayStart + (hour - 9) * 3_600_000;
      return meetings.filter(([from, to]) => from < start + 30 * 60_000 && to > start);
    };
    expect(clashes(14)).toHaveLength(0);
    expect(clashes(16)).toHaveLength(1);
  });

  it("makes initial evidence available before the briefing, then supplies the material change before committee", () => {
    const at = (ref: string) => spec.beats.find(b => b.ref === ref)!.tick;
    expect(at("vc-finance-correction")).toBeLessThan(24);
    expect(at("vc-reference-evidence")).toBeLessThan(24);
    expect(at("vc-renewal-update")).toBeGreaterThan(24);
    expect(at("vc-renewal-update")).toBeLessThan(28);
    expect(tickToISO(spec.clock, 24)).toBe("2026-09-15T14:00:00.000Z");
    // The opening company must not disclose a decision that has not happened yet.
    expect(JSON.stringify(backlog)).not.toContain("decided not to renew");
  });

  it("defers content judgements instead of treating a sent message as evidence of accurate analysis", () => {
    const contentCriteria = spec.success.checklist.filter(c => c.kind === "judged");
    const refs = Object.fromEntries(spec.beats.filter(b => b.ref).map(b => [b.ref!, { twin: b.twin, id: b.id, tick: b.tick }]));
    const checked = runChecklist({ criteria: contentCriteria, world: spec.world, beats: spec.beats, refs, snapshots: {}, audit: [], escalations: [] });
    expect(checked.results).toEqual([]);
    expect(checked.deferred.map(c => c.id)).toEqual(["vc-c5", "vc-c6", "vc-c7", "vc-c8"]);
    expect(spec.success.checklist.some(c => c.kind === "no-escalation")).toBe(false);
  });
});
