import {
  beatsAt,
  danglingRefs,
  episodeTwins,
  isoToTick,
  lastTick,
  offsetMinutes,
  resolvePerson,
  owner,
  type Beat,
  type EpisodeSpec,
} from "@sonata/core";
import { factNameFor } from "@sonata/judge/checklist";
import { describe, expect, it } from "vitest";
import { SCENARIOS, getScenario, scenarioIds } from "../src/index";
import { SIM_MINUTES_PER_TICK, WORKDAY_TICKS } from "../src/day";

// These specs are data, and data rots quietly: a beat pointing at a ref nobody
// creates, a criterion on a (twin, kind) pair no checker implements, a channel
// renamed in the world but not in the beats. None of that throws — it produces a
// run that looks like a badly behaved agent. So every structural promise the
// engine and the judge rely on is asserted here, before a scenario ever costs a
// model call.

const SPECS: EpisodeSpec[] = [...SCENARIOS];

/** The date part of the clock, e.g. "2026-09-15" — every event shares it. */
function dayOf(spec: EpisodeSpec): string {
  return spec.clock.startISO.slice(0, 10);
}

function offsetOf(spec: EpisodeSpec): string {
  return spec.clock.startISO.slice(19);
}

/** Every absolute instant a beat carries, with a label for the failure message. */
function instants(beat: Beat): Array<{ what: string; iso: string }> {
  if (beat.twin !== "calendar") return [];
  if (beat.kind === "invite" || beat.kind === "move") {
    return [
      { what: `${beat.id} start`, iso: beat.payload.startISO },
      { what: `${beat.id} end`, iso: beat.payload.endISO },
    ];
  }
  return [];
}

function refsOf(spec: EpisodeSpec): string[] {
  return spec.beats.map((b) => b.ref).filter((r): r is string => !!r);
}

/**
 * What a beat points backwards at: a thread, a parent message, an event.
 *
 * The five scenarios in this package are a mailbox, a workspace and a diary, so
 * anything on the four later surfaces is `undefined` here rather than reached
 * for — a ref this function invented for a twin no scenario uses would be
 * asserted against a registry that never held it.
 */
function backReference(beat: Beat): string | undefined {
  if (beat.twin === "gmail") return beat.payload.inReplyTo;
  if (beat.twin === "slack") {
    return beat.kind === "reaction" ? beat.payload.messageRef : beat.payload.threadRef;
  }
  if (beat.twin !== "calendar") return undefined;
  return beat.kind === "invite" ? undefined : beat.payload.eventRef;
}

describe("the registry", () => {
  it("holds the five article scenarios, addressable by id", () => {
    expect(scenarioIds()).toEqual([
      "client-escalation",
      "invoice-chase",
      "candidate-scheduling",
      "outage-comms",
      "travel-day",
    ]);
    for (const id of scenarioIds()) expect(getScenario(id)?.id).toBe(id);
    expect(getScenario("no-such-day")).toBeUndefined();
  });

  it("gives every scenario, beat and criterion a unique id", () => {
    const specIds = SPECS.map((s) => s.id);
    expect(new Set(specIds).size).toBe(specIds.length);

    // Beat ids are unique across the whole registry, not just within a spec:
    // runs from different scenarios land in one store and one timeline.
    const beatIds = SPECS.flatMap((s) => s.beats.map((b) => b.id));
    expect(new Set(beatIds).size).toBe(beatIds.length);

    const criterionIds = SPECS.flatMap((s) => s.success.checklist.map((c) => c.id));
    expect(new Set(criterionIds).size).toBe(criterionIds.length);
  });
});

describe.each(SPECS.map((s) => [s.id, s] as const))("%s", (_id, spec) => {
  it("runs one 09:00–18:00 workday with a real UTC offset", () => {
    expect(spec.clock.ticks).toBe(WORKDAY_TICKS);
    expect(spec.clock.simMinutesPerTick).toBe(SIM_MINUTES_PER_TICK);
    expect(spec.clock.startISO).toMatch(/T09:00:00(?:Z|[+-]\d{2}:\d{2})$/);
    // Throws on an offsetless start, which is the failure this guards.
    expect(Number.isFinite(offsetMinutes(spec.clock.startISO))).toBe(true);
  });

  it("fires every beat inside the day", () => {
    for (const beat of spec.beats) {
      expect(Number.isInteger(beat.tick), `${beat.id} tick`).toBe(true);
      expect(beat.tick, `${beat.id} tick`).toBeGreaterThanOrEqual(0);
      expect(beat.tick, `${beat.id} tick`).toBeLessThanOrEqual(lastTick(spec.clock));
    }
  });

  it("spreads the beats across the day rather than dumping them at 09:00", () => {
    const ticks = spec.beats.map((b) => b.tick);
    const distinct = new Set(ticks);
    expect(distinct.size).toBeGreaterThanOrEqual(10);
    // Something has to still be happening after lunch, or the "day" is a fixture
    // with a long silence attached.
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(spec.clock.ticks * 0.75);
    for (const [from, to] of [
      [0, 11],
      [12, 23],
      [24, 35],
    ]) {
      const inThird = ticks.filter((t) => t >= from && t <= to);
      expect(inThird.length, `beats in ticks ${from}–${to}`).toBeGreaterThan(0);
    }
    // No single tick may carry more than the opening state of the world.
    for (const tick of distinct) {
      expect(beatsAt(spec.beats, tick).length, `beats at tick ${tick}`).toBeLessThanOrEqual(5);
    }
  });

  it("dates every calendar event on the episode's own day and offset", () => {
    for (const beat of spec.beats) {
      for (const { what, iso } of instants(beat)) {
        expect(iso.slice(0, 10), what).toBe(dayOf(spec));
        expect(iso.slice(19), what).toBe(offsetOf(spec));
      }
      if (beat.twin === "calendar" && (beat.kind === "invite" || beat.kind === "move")) {
        expect(
          Date.parse(beat.payload.endISO) > Date.parse(beat.payload.startISO),
          `${beat.id} ends after it starts`,
        ).toBe(true);
        // Events may sit outside working hours (an evening flight), but not on
        // another day — `isoToTick` is what the timeline renders them with.
        expect(isoToTick(spec.clock, beat.payload.startISO)).toBeGreaterThan(-8);
      }
    }
  });

  it("resolves every ref, and never points backwards at a beat that has not fired", () => {
    expect(danglingRefs(spec)).toEqual([]);

    const refs = refsOf(spec);
    expect(new Set(refs).size, "duplicate beat refs").toBe(refs.length);

    const tickOfRef = new Map(spec.beats.filter((b) => b.ref).map((b) => [b.ref, b.tick]));
    for (const beat of spec.beats) {
      const back = backReference(beat);
      if (!back) continue;
      expect(tickOfRef.get(back), `${beat.id} → ${back}`).toBeLessThanOrEqual(beat.tick);
    }
  });

  it("names only people and channels the world contains", () => {
    const channels = new Set(spec.world.channels.map((c) => c.name));
    const known = (ref: string): boolean =>
      resolvePerson(spec.world, ref) !== undefined || ref.includes("@");

    for (const beat of spec.beats) {
      if (beat.twin === "gmail") {
        for (const who of [beat.payload.from, ...beat.payload.to, ...(beat.payload.cc ?? [])]) {
          expect(known(who), `${beat.id} → ${who}`).toBe(true);
        }
      }
      if (beat.twin === "slack") {
        expect(known(beat.payload.from), `${beat.id} → ${beat.payload.from}`).toBe(true);
        if (beat.kind === "message") {
          expect(channels.has(beat.payload.channel), `${beat.id} → #${beat.payload.channel}`).toBe(
            true,
          );
        }
      }
      if (beat.twin === "calendar" && beat.kind === "invite") {
        for (const who of [beat.payload.organizer, ...beat.payload.attendees]) {
          expect(known(who), `${beat.id} → ${who}`).toBe(true);
        }
      }
    }
    // The owner never sends themselves the day's mail — that is the agent's job.
    const ownerId = owner(spec.world).id;
    for (const beat of spec.beats) {
      if (beat.twin === "gmail") expect(beat.payload.from).not.toBe(ownerId);
      if (beat.twin === "slack") expect(beat.payload.from).not.toBe(ownerId);
    }
  });

  it("needs at least two twins to solve", () => {
    const twins = episodeTwins(spec);
    expect(twins.length, `twins: ${twins.join(", ")}`).toBeGreaterThanOrEqual(2);

    const beatTwins = new Set(spec.beats.map((b) => b.twin));
    expect(beatTwins.size, "surfaces the day happens on").toBeGreaterThanOrEqual(2);
  });

  it("scores against 4–8 criteria a checker can actually decide", () => {
    const checklist = spec.success.checklist;
    expect(checklist.length).toBeGreaterThanOrEqual(4);
    expect(checklist.length).toBeLessThanOrEqual(8);
    expect(checklist.some((c) => c.severity === "must")).toBe(true);
    expect(checklist.some((c) => c.severity === "should")).toBe(true);
    expect(new Set(checklist.map((c) => c.twin)).size).toBeGreaterThanOrEqual(2);

    const beatRefs = new Set(refsOf(spec));
    const channels = new Set(spec.world.channels.map((c) => c.name));

    for (const c of checklist) {
      expect(c.weight, `${c.id} weight`).toBeGreaterThan(0);
      // Every criterion carries a stable ref: it is what the results page opens
      // onto, and for half the kinds it is also what the checker resolves.
      expect(beatRefs.has(c.ref ?? ""), `${c.id} ref "${c.ref}"`).toBe(true);

      if (c.kind !== "judged") {
        expect(factNameFor(c.twin, c.kind), `${c.id} — ${c.twin}/${c.kind}`).not.toBeNull();
      }
      if (c.kind === "posted") {
        expect(channels.has(c.expect ?? c.target ?? ""), `${c.id} channel`).toBe(true);
      }
      if (c.kind === "mentions" || c.kind === "labelled") {
        expect(c.expect, `${c.id} needs a phrase`).toBeTruthy();
      }
      if (c.kind === "sent") {
        const target = c.target ?? "";
        expect(
          resolvePerson(spec.world, target) !== undefined || target.includes("@"),
          `${c.id} target "${target}"`,
        ).toBe(true);
      }
    }

    expect(spec.success.judgeQuestions.length).toBeGreaterThanOrEqual(2);
    expect(spec.success.judgeQuestions.length).toBeLessThanOrEqual(3);
  });

  it("directs the world without letting it solve the day", () => {
    const { director } = spec;
    expect(director.maxEventsPerTick).toBeGreaterThanOrEqual(2);
    expect(director.maxEventsPerTick).toBeLessThanOrEqual(3);
    expect(director.personas.length).toBeGreaterThanOrEqual(3);
    expect(director.offLimits.length).toBeGreaterThanOrEqual(4);
    expect(director.style.length).toBeGreaterThan(40);

    const ownerId = owner(spec.world).id;
    for (const persona of director.personas) {
      // A persona the director cannot resolve is silently dropped from its
      // prompt, so an outsider who has to answer must be in the cast.
      const person = resolvePerson(spec.world, persona.personId);
      expect(person, `persona ${persona.personId} is in the cast`).toBeDefined();
      expect(person?.id, "the world never speaks as the mailbox owner").not.toBe(ownerId);
      expect(persona.responsiveness).toBeGreaterThan(0);
      expect(persona.responsiveness).toBeLessThanOrEqual(1);
      expect(persona.replyDelayTicks).toBeGreaterThanOrEqual(0);
      expect(persona.surfaces.length).toBeGreaterThan(0);
    }
    expect(new Set(director.personas.map((p) => p.personId)).size).toBe(director.personas.length);
  });

  it("declares a brief and a story worth giving to a judge", () => {
    expect(spec.task.length).toBeGreaterThan(200);
    expect(spec.story.length).toBeGreaterThan(400);
    expect(spec.title.length).toBeGreaterThan(10);
    // The brief must not name the answer: the agent finds the day for itself.
    for (const ref of refsOf(spec)) expect(spec.task).not.toContain(ref);
  });

  it("declares stop conditions rather than trusting the loop", () => {
    const { termination } = spec;
    expect(termination.idleTicks).toBeGreaterThan(0);
    expect(termination.idleTicks).toBeLessThan(spec.clock.ticks);
    expect(termination.maxWallClockMs).toBeGreaterThan(0);
    expect(termination.maxCostUsd ?? 0).toBeGreaterThan(0);
    // Stopping at the last `must` would cut the day off before the beats that
    // change it — every one of these episodes turns after lunch.
    expect(termination.stopWhenAllMustPass).toBe(false);
  });
});
