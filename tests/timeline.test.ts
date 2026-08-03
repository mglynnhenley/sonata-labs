import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  humanPhrase,
  rebaseSlots,
  timelineStage,
  NO_ANCHOR_PHRASE,
} from "@/lib/eval/generate/timeline";
import type { SlotTime, StageCtx } from "@/lib/eval/generate/types";
import type { MessageSlot, StressScenario } from "@/lib/eval/types";

// Stage 4 of the generator pipeline. Pure code, fixed clock — no network, no
// sandbox, no model. This is the stage that fixes the harness's actual bug: the
// generator used to write "as I mentioned yesterday" onto a three-month-old
// thread because `Anchor` carried no timestamp, so every date the composer is
// allowed to quote now comes from here, resolved against the anchor's real
// `internalDate`.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Tue 28 Jul 2026, 12:00 UTC. Every expectation below is relative to this. */
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

function slot(at: number, slotId = `s${at}`): SlotTime {
  return { slotId, at, phrase: "unset" };
}

/** Scenario slots are declared oldest-first, i.e. `minutesAgo` descending. */
function msg(id: string, minutesAgo: number): MessageSlot {
  return { id, sender: "contact", minutesAgo, labels: ["INBOX", "UNREAD"], brief: "" };
}

function gaps(slots: SlotTime[]): number[] {
  return slots.slice(1).map((s, i) => s.at - slots[i].at);
}

// Deterministic PRNG so the fuzz cases are reproducible on every machine.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("humanPhrase", () => {
  it("says 'just now' inside the first minute", () => {
    expect(humanPhrase(NOW, NOW)).toBe("just now");
    expect(humanPhrase(NOW - 30_000, NOW)).toBe("just now");
    expect(humanPhrase(NOW - MINUTE + 1, NOW)).toBe("just now");
  });

  it("renders minutes, singular and plural", () => {
    expect(humanPhrase(NOW - MINUTE, NOW)).toBe("1 minute ago");
    expect(humanPhrase(NOW - 2 * MINUTE, NOW)).toBe("2 minutes ago");
    expect(humanPhrase(NOW - 25 * MINUTE, NOW)).toBe("25 minutes ago");
    expect(humanPhrase(NOW - 59 * MINUTE, NOW)).toBe("59 minutes ago");
  });

  it("renders hours within the same UTC calendar day", () => {
    expect(humanPhrase(NOW - HOUR, NOW)).toBe("1 hour ago");
    expect(humanPhrase(NOW - 90 * MINUTE, NOW)).toBe("1 hour ago");
    expect(humanPhrase(NOW - 5 * HOUR, NOW)).toBe("5 hours ago");
  });

  it("says 'yesterday' by calendar day, not by elapsed hours", () => {
    // 11pm on the 27th, read at 1am on the 28th: two hours elapsed, but a person
    // says "yesterday".
    const earlyMorning = Date.UTC(2026, 6, 28, 1, 0, 0);
    expect(humanPhrase(Date.UTC(2026, 6, 27, 23, 0, 0), earlyMorning)).toBe("yesterday");
    // And a full day earlier from noon is still just "yesterday".
    expect(humanPhrase(NOW - DAY, NOW)).toBe("yesterday");
  });

  it("carries the absolute date alongside the relative age for days", () => {
    expect(humanPhrase(NOW - 3 * DAY, NOW)).toBe("Sat 25 Jul, 3 days ago");
    expect(humanPhrase(NOW - 6 * DAY, NOW)).toBe("Wed 22 Jul, 6 days ago");
  });

  it("renders weeks between 7 days and a calendar month", () => {
    expect(humanPhrase(NOW - 7 * DAY, NOW)).toBe("Tue 21 Jul, 1 week ago");
    expect(humanPhrase(NOW - 10 * DAY, NOW)).toBe("Sat 18 Jul, 1 week ago");
    expect(humanPhrase(NOW - 29 * DAY, NOW)).toBe("Mon 29 Jun, 4 weeks ago");
  });

  it("renders whole calendar months", () => {
    expect(humanPhrase(Date.UTC(2026, 5, 28, 9, 0, 0), NOW)).toBe("Sun 28 Jun, 1 month ago");
    expect(humanPhrase(Date.UTC(2026, 3, 28, 9, 30, 0), NOW)).toBe("Tue 28 Apr, 3 months ago");
    // One day short of three whole months is two months, not three.
    expect(humanPhrase(Date.UTC(2026, 3, 29, 9, 30, 0), NOW)).toContain("2 months ago");
  });

  it("renders years past twelve months", () => {
    expect(humanPhrase(Date.UTC(2025, 0, 15, 8, 0, 0), NOW)).toBe("Wed 15 Jan, 1 year ago");
  });

  it("never renders a future instant as the future", () => {
    // Only reachable from a caller that skipped rebaseSlots; every consumer is
    // prose about something that already happened.
    expect(humanPhrase(NOW + DAY, NOW)).toBe("just now");
    expect(humanPhrase(NOW + 1, NOW)).toBe("just now");
  });

  it("is a pure function of (at, now) — no wall clock", () => {
    const a = humanPhrase(NOW - 3 * DAY, NOW);
    const b = humanPhrase(NOW - 3 * DAY, NOW);
    expect(a).toBe(b);
    // Same offset, different absolute clock -> same relative wording.
    const shifted = humanPhrase(NOW - 3 * DAY - 400 * DAY, NOW - 400 * DAY);
    expect(shifted).toContain("3 days ago");
  });
});

describe("rebaseSlots — invariant 1: nothing is future-dated", () => {
  it("clamps slots that would land after now", () => {
    const out = rebaseSlots([slot(NOW - HOUR, "a"), slot(NOW + 5 * DAY, "b")], 0, NOW);
    expect(out.every((s) => s.at <= NOW)).toBe(true);
    expect(out[1].at).toBe(NOW);
  });

  it("collapses onto now rather than the future when the anchor is newer than now", () => {
    // Degenerate, from a bad sync: a future-dated anchor must never drag probes
    // into the future.
    const out = rebaseSlots([slot(NOW - DAY, "a"), slot(NOW - HOUR, "b")], NOW + DAY, NOW);
    expect(out.map((s) => s.at)).toEqual([NOW, NOW]);
    expect(out.every((s) => s.at <= NOW)).toBe(true);
  });

  it("holds under fuzz across anchors, offsets and orderings", () => {
    const rand = mulberry32(20260728);
    for (let n = 0; n < 500; n++) {
      const count = 1 + Math.floor(rand() * 4);
      const slots = Array.from({ length: count }, (_, i) =>
        slot(NOW - Math.floor(rand() * 200 * DAY) + (rand() < 0.1 ? 30 * DAY : 0), `s${i}`),
      );
      const anchor =
        rand() < 0.2 ? 0 : NOW - Math.floor(rand() * 300 * DAY) + (rand() < 0.1 ? 10 * DAY : 0);
      const out = rebaseSlots(slots, anchor, NOW);
      for (const s of out) expect(s.at).toBeLessThanOrEqual(NOW);
    }
  });
});

describe("rebaseSlots — invariant 2: declared chronological order survives", () => {
  it("keeps slot identity and order in the output array", () => {
    const out = rebaseSlots(
      [slot(NOW - 10 * DAY, "prior"), slot(NOW - 2 * DAY, "chase"), slot(NOW - 25 * MINUTE, "probe")],
      0,
      NOW,
    );
    expect(out.map((s) => s.slotId)).toEqual(["prior", "chase", "probe"]);
    expect(out.map((s) => s.at)).toEqual([NOW - 10 * DAY, NOW - 2 * DAY, NOW - 25 * MINUTE]);
  });

  it("pulls a straggler forward instead of emitting messages that answer backwards", () => {
    // A scenario listing an older slot after a newer one is a scenario bug, but
    // the fixture still has to read as one conversation.
    const out = rebaseSlots([slot(NOW - 100 * MINUTE, "a"), slot(NOW - 500 * MINUTE, "b")], 0, NOW);
    expect(out[1].at).toBeGreaterThanOrEqual(out[0].at);
    expect(out.map((s) => s.at)).toEqual([NOW - 100 * MINUTE, NOW - 100 * MINUTE]);
  });

  it("is non-decreasing under fuzz, including after compression rounding", () => {
    const rand = mulberry32(7);
    for (let n = 0; n < 500; n++) {
      const count = 1 + Math.floor(rand() * 5);
      const slots = Array.from({ length: count }, (_, i) =>
        slot(NOW - Math.floor(rand() * 120 * DAY), `s${i}`),
      );
      const anchor = rand() < 0.25 ? 0 : NOW - Math.floor(rand() * 120 * DAY);
      const out = rebaseSlots(slots, anchor, NOW);
      for (let i = 1; i < out.length; i++) {
        expect(out[i].at).toBeGreaterThanOrEqual(out[i - 1].at);
      }
    }
  });
});

describe("rebaseSlots — invariant 3: every slot lands after the anchor", () => {
  it("shifts the whole set forward when the oldest slot predates the anchor", () => {
    const anchor = NOW - 10 * DAY;
    const out = rebaseSlots([slot(NOW - 30 * DAY, "a"), slot(NOW - 20 * DAY, "b")], anchor, NOW);
    for (const s of out) expect(s.at).toBeGreaterThan(anchor);
    expect(out[0].at).toBe(anchor + MINUTE);
  });

  it("leaves slots alone when they already sit after the anchor", () => {
    const anchor = NOW - 40 * DAY;
    const input = [slot(NOW - 4 * DAY, "a"), slot(NOW - 25 * MINUTE, "b")];
    const out = rebaseSlots(input, anchor, NOW);
    expect(out.map((s) => s.at)).toEqual([NOW - 4 * DAY, NOW - 25 * MINUTE]);
    for (const s of out) expect(s.at).toBeGreaterThan(anchor);
  });

  it("holds under fuzz for any anchor at least a minute old", () => {
    const rand = mulberry32(99);
    for (let n = 0; n < 500; n++) {
      const count = 1 + Math.floor(rand() * 4);
      const slots = Array.from({ length: count }, (_, i) =>
        slot(NOW - Math.floor(rand() * 300 * DAY), `s${i}`),
      );
      // Any real anchor is at least MIN_GAP_MS old; only a corrupt sync is not.
      const anchor = NOW - MINUTE - Math.floor(rand() * 300 * DAY);
      const out = rebaseSlots(slots, anchor, NOW);
      for (const s of out) expect(s.at).toBeGreaterThan(anchor);
    }
  });

  it("treats anchorLastAt <= 0 as 'no anchor' and still applies invariants 1 and 2", () => {
    const input = [slot(NOW - 2 * DAY, "a"), slot(NOW - 9 * DAY, "b"), slot(NOW + DAY, "c")];
    for (const noAnchor of [0, -1]) {
      const out = rebaseSlots(input, noAnchor, NOW);
      expect(out.map((s) => s.at)).toEqual([NOW - 2 * DAY, NOW - 2 * DAY, NOW]);
    }
  });
});

describe("rebaseSlots — gap handling", () => {
  it("preserves the gaps between slots when it shifts", () => {
    // The gaps are the shape of the conversation ("she chased three days after
    // the original ask"); clamping each slot separately would flatten them.
    const anchor = NOW - 30 * DAY;
    const input = [
      slot(NOW - 90 * DAY, "ask"),
      slot(NOW - 87 * DAY, "chase"),
      slot(NOW - 80 * DAY, "probe"),
    ];
    const out = rebaseSlots(input, anchor, NOW);
    expect(gaps(out)).toEqual(gaps(input));
    expect(out[0].at).toBe(anchor + MINUTE);
    for (const s of out) expect(s.at).toBeGreaterThan(anchor);
    expect(out.every((s) => s.at <= NOW)).toBe(true);
  });

  it("compresses gaps proportionally when a naive shift would overshoot now", () => {
    const anchor = NOW - 30 * MINUTE;
    const input = [
      slot(NOW - 3000 * MINUTE, "a"),
      slot(NOW - 1000 * MINUTE, "b"),
      slot(NOW - 100 * MINUTE, "c"),
    ];
    const out = rebaseSlots(input, anchor, NOW);

    // Room available is [anchor + 1min, now] = 29 minutes; the original span is
    // 2900 minutes, so everything scales by 1/100 and the rhythm survives.
    expect(out[0].at).toBe(anchor + MINUTE);
    expect(out[2].at).toBe(NOW);
    expect(gaps(out)).toEqual([20 * MINUTE, 9 * MINUTE]);

    const inGaps = gaps(input);
    const outGaps = gaps(out);
    expect(outGaps[0] / outGaps[1]).toBeCloseTo(inGaps[0] / inGaps[1], 6);
    for (const s of out) expect(s.at).toBeGreaterThan(anchor);
  });

  it("keeps relative gap ratios under compression for a range of anchors", () => {
    const input = [slot(NOW - 40 * DAY, "a"), slot(NOW - 30 * DAY, "b"), slot(NOW - 10 * DAY, "c")];
    const expected = gaps(input);
    const ratio = expected[0] / expected[1];
    for (const minutesOld of [5, 60, 6 * 60, 24 * 60]) {
      const anchor = NOW - minutesOld * MINUTE;
      const out = rebaseSlots(input, anchor, NOW);
      const g = gaps(out);
      expect(g[0]).toBeGreaterThan(0);
      expect(g[1]).toBeGreaterThan(0);
      expect(g[0] / g[1]).toBeCloseTo(ratio, 3);
      expect(out[out.length - 1].at).toBeLessThanOrEqual(NOW);
      expect(out[0].at).toBeGreaterThan(anchor);
    }
  });

  it("handles a single slot and an empty list", () => {
    expect(rebaseSlots([], NOW - DAY, NOW)).toEqual([]);
    const one = rebaseSlots([slot(NOW - 90 * DAY, "only")], NOW - 2 * MINUTE, NOW);
    expect(one).toHaveLength(1);
    expect(one[0].at).toBe(NOW - MINUTE);
    expect(one[0].phrase).toBe("1 minute ago");
  });

  it("re-derives every phrase from the time it actually returns", () => {
    const anchor = NOW - 45 * MINUTE;
    const out = rebaseSlots(
      [slot(NOW - 50 * DAY, "a"), slot(NOW - 20 * DAY, "b"), slot(NOW - DAY, "c")],
      anchor,
      NOW,
    );
    for (const s of out) expect(s.phrase).toBe(humanPhrase(s.at, NOW));
    // The stale placeholder phrase from the input must never leak through.
    expect(out.some((s) => s.phrase === "unset")).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = [slot(NOW - 90 * DAY, "a"), slot(NOW - 80 * DAY, "b")];
    const before = JSON.parse(JSON.stringify(input));
    rebaseSlots(input, NOW - 2 * MINUTE, NOW);
    expect(input).toEqual(before);
  });
});

describe("buildTimeline", () => {
  it("resolves minutesAgo against the injected clock, not Date.now()", () => {
    const t = buildTimeline([msg("prior", 4 * 24 * 60), msg("probe", 25)], null, NOW);
    expect(t.slots.map((s) => s.slotId)).toEqual(["prior", "probe"]);
    expect(t.slots.map((s) => s.at)).toEqual([NOW - 4 * DAY, NOW - 25 * MINUTE]);
  });

  it("reports no anchor as 0 / NO_ANCHOR_PHRASE for null, 0 and negatives", () => {
    for (const bad of [null, 0, -1]) {
      const t = buildTimeline([msg("probe", 10)], bad, NOW);
      expect(t.anchorLastAt).toBe(0);
      expect(t.anchorPhrase).toBe(NO_ANCHOR_PHRASE);
    }
  });

  // ---------------------------------------------------------------------
  // THE REGRESSION TEST FOR THE ORIGINAL BUG.
  //
  // Before this stage existed, `Anchor` carried no timestamp, so the composer
  // was told "continue this real thread" with no idea the thread had gone quiet
  // in April — and it wrote "as I mentioned yesterday" onto three-month-old
  // mail. The agent under test then received a probe contradicted by its own
  // history: an unfair test that hides real failures.
  //
  // The fix is that the anchor's age is resolved here, in code, and handed to
  // the composer as a ready-made phrase it can quote verbatim.
  // ---------------------------------------------------------------------
  it("dates a 3-month-old anchor as three months old, not as yesterday", () => {
    const anchorLastAt = Date.UTC(2026, 3, 28, 9, 30, 0); // Tue 28 Apr 2026
    const t = buildTimeline([msg("prior", 4 * 24 * 60), msg("probe", 25)], anchorLastAt, NOW);

    // The anchor phrase must convey ~3 months, with the absolute date attached.
    expect(t.anchorPhrase).toBe("Tue 28 Apr, 3 months ago");
    expect(t.anchorPhrase).toContain("3 months ago");
    expect(t.anchorPhrase).not.toMatch(/yesterday|minute|hour|just now/);
    expect(t.anchorLastAt).toBe(anchorLastAt);

    // Both slots are far newer than the anchor, so they keep their scenario
    // offsets — the anchor being old must not drag the probe backwards.
    expect(t.slots.map((s) => s.at)).toEqual([NOW - 4 * DAY, NOW - 25 * MINUTE]);
    expect(t.slots[0].phrase).toBe("Fri 24 Jul, 4 days ago");
    expect(t.slots[1].phrase).toBe("25 minutes ago");

    // And the invariants still hold against the real anchor date.
    for (const s of t.slots) {
      expect(s.at).toBeGreaterThan(anchorLastAt);
      expect(s.at).toBeLessThanOrEqual(NOW);
    }
    // The gap the composer must respect: roughly three months of silence, not a day.
    expect(t.slots[0].at - t.anchorLastAt).toBeGreaterThan(80 * DAY);
  });

  it("rebases slots that would predate a recent anchor", () => {
    // Anchor from two hours ago, scenario wants a 4-day-old prior message: the
    // prior cannot exist before the thread it continues.
    const anchorLastAt = NOW - 2 * HOUR;
    const t = buildTimeline([msg("prior", 4 * 24 * 60), msg("probe", 25)], anchorLastAt, NOW);
    for (const s of t.slots) {
      expect(s.at).toBeGreaterThan(anchorLastAt);
      expect(s.at).toBeLessThanOrEqual(NOW);
    }
    expect(t.slots[0].at).toBeLessThan(t.slots[1].at);
    expect(t.anchorPhrase).toBe("2 hours ago");
  });

  it("returns an empty slot list for a scenario with no slots", () => {
    const t = buildTimeline([], NOW - DAY, NOW);
    expect(t.slots).toEqual([]);
    expect(t.anchorPhrase).toBe("yesterday");
  });

  it("is deterministic: same (slots, anchorLastAt, now) gives identical output", () => {
    const slots = [msg("prior", 5000), msg("chase", 900), msg("probe", 25)];
    for (const anchor of [null, NOW - 10 * MINUTE, NOW - 91 * DAY]) {
      const a = buildTimeline(slots, anchor, NOW);
      const b = buildTimeline(slots, anchor, NOW);
      const c = buildTimeline(slots.slice(), anchor, NOW);
      expect(a).toEqual(b);
      expect(a).toEqual(c);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it("rebaseSlots is deterministic across repeated calls on its own output", () => {
    const input = [slot(NOW - 3000 * MINUTE, "a"), slot(NOW - 100 * MINUTE, "b")];
    const anchor = NOW - 30 * MINUTE;
    const once = rebaseSlots(input, anchor, NOW);
    const twice = rebaseSlots(input, anchor, NOW);
    expect(twice).toEqual(once);
    // Idempotent: re-running on already-valid times changes nothing.
    expect(rebaseSlots(once, anchor, NOW)).toEqual(once);
  });
});

describe("timelineStage", () => {
  function ctxFor(slots: MessageSlot[], now = NOW): { ctx: StageCtx; said: string[] } {
    const said: string[] = [];
    const scenario = { id: "test", slots } as unknown as StressScenario;
    const ctx = {
      gmail: {} as never,
      userId: "me",
      scenario,
      profile: {} as never,
      now,
      model: () => undefined,
      say: (m: string) => said.push(m),
    } as unknown as StageCtx;
    return { ctx, said };
  }

  it("is named 'timeline' and returns exactly what buildTimeline returns", async () => {
    const slots = [msg("prior", 4 * 24 * 60), msg("probe", 25)];
    const { ctx } = ctxFor(slots);
    expect(timelineStage.name).toBe("timeline");
    const anchorLastAt = Date.UTC(2026, 3, 28, 9, 30, 0);
    const out = await timelineStage.run({ anchorLastAt }, ctx);
    expect(out).toEqual(buildTimeline(slots, anchorLastAt, NOW));
  });

  it("explains the anchor's age and every slot phrase on the progress line", async () => {
    const slots = [msg("prior", 4 * 24 * 60), msg("probe", 25)];
    const { ctx, said } = ctxFor(slots);
    await timelineStage.run({ anchorLastAt: Date.UTC(2026, 3, 28, 9, 30, 0) }, ctx);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Tue 28 Apr, 3 months ago");
    expect(said[0]).toContain("prior Fri 24 Jul, 4 days ago");
    expect(said[0]).toContain("probe 25 minutes ago");
  });

  it("handles a null anchor without touching the wall clock", async () => {
    const { ctx, said } = ctxFor([msg("probe", 25)]);
    const out = await timelineStage.run({ anchorLastAt: null }, ctx);
    expect(out.anchorLastAt).toBe(0);
    expect(out.anchorPhrase).toBe(NO_ANCHOR_PHRASE);
    expect(out.slots[0].at).toBe(NOW - 25 * MINUTE);
    expect(said[0]).toContain(NO_ANCHOR_PHRASE);
  });
});
