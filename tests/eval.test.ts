import { describe, it, expect } from "vitest";
import { SCENARIOS, getScenario, scenarioIds } from "@/lib/eval/scenarios/index";
import { gradeRun, runAssertions } from "@/lib/eval/grade";
import { bindContact } from "@/lib/eval/generate";
import type {
  Fixture,
  GradeCtx,
  MailboxProfile,
  ProbeOutcome,
  StressScenario,
} from "@/lib/eval/types";

// All pure — no sandbox, no model calls. The assertion predicates are the load-
// bearing part of grading, so they get direct coverage.

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    messageId: "probe1",
    threadId: "thread1",
    exists: true,
    finalLabels: ["INBOX", "UNREAD"],
    archived: false,
    trashed: false,
    starred: false,
    markedRead: false,
    labelsAdded: [],
    replied: false,
    replyText: "",
    touchedPrior: false,
    surfacedPrior: false,
    actions: [],
    allActions: [],
    ...over,
  };
}

function ctxFor(scenario: StressScenario): GradeCtx {
  const messages = scenario.slots.map((s) => ({
    slotId: s.id,
    from: "Contact <contact@example.com>",
    to: "Owner <owner@example.com>",
    subject: `subject-${s.id}`,
    text: `body-${s.id}`,
    minutesAgo: s.minutesAgo,
    labels: s.labels,
  }));
  const probeSlotId = scenario.slots.some((s) => s.id === "probe")
    ? "probe"
    : scenario.slots[scenario.slots.length - 1].id;
  const priorSlotId = scenario.slots.find((s) => s.id !== probeSlotId)?.id;
  const fixture: Fixture = { messages, probeSlotId, priorSlotId };
  const injected = messages.map((m) => ({
    slotId: m.slotId,
    id: `id-${m.slotId}`,
    threadId: "thread1",
    rfc822MessageId: `<${m.slotId}@x>`,
  }));
  return {
    scenario,
    fixture,
    injected,
    probe: injected.find((i) => i.slotId === probeSlotId)!,
    prior: priorSlotId ? injected.find((i) => i.slotId === priorSlotId) : undefined,
    anchor: null,
  };
}

describe("scenario catalog", () => {
  it("has unique ids", () => {
    const ids = scenarioIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers both difficulty families", () => {
    const families = new Set(SCENARIOS.map((s) => s.family));
    expect(families).toContain("requires-history");
    expect(families).toContain("interpersonal");
  });

  it("every scenario has at least one must assertion and a judge question", () => {
    for (const s of SCENARIOS) {
      expect(s.assertions.some((a) => a.severity === "must"), s.id).toBe(true);
      expect(s.judgeQuestion.length, s.id).toBeGreaterThan(20);
    }
  });

  it("every scenario has a probe slot and unique slot ids", () => {
    for (const s of SCENARIOS) {
      const ids = s.slots.map((x) => x.id);
      expect(new Set(ids).size, s.id).toBe(ids.length);
      expect(ids.includes("probe"), s.id).toBe(true);
    }
  });

  it("threadWith always references a real slot or the anchor", () => {
    for (const s of SCENARIOS) {
      const ids = new Set(s.slots.map((x) => x.id));
      for (const slot of s.slots) {
        if (!slot.threadWith) continue;
        const ok = slot.threadWith === "anchor" || ids.has(slot.threadWith);
        expect(ok, `${s.id}/${slot.id} -> ${slot.threadWith}`).toBe(true);
      }
    }
  });

  it("assertion ids are unique within a scenario", () => {
    for (const s of SCENARIOS) {
      const ids = s.assertions.map((a) => a.id);
      expect(new Set(ids).size, s.id).toBe(ids.length);
    }
  });

  it("getScenario throws a helpful error for unknown ids", () => {
    expect(() => getScenario("nope")).toThrow(/Unknown scenario/);
  });
});

describe("assertion predicates", () => {
  const escalation = getScenario("escalation");
  const ctx = ctxFor(escalation);
  const run = (o: ProbeOutcome) =>
    Object.fromEntries(runAssertions(o, ctx).map((r) => [r.id, r.passed]));

  it("archiving an escalation violates a must", () => {
    const r = run(outcome({ archived: true, finalLabels: ["UNREAD"] }));
    expect(r["not-archived"]).toBe(false);
  });

  it("trashing violates a must", () => {
    expect(run(outcome({ trashed: true }))["not-trashed"]).toBe(false);
    expect(run(outcome({ exists: false }))["not-trashed"]).toBe(false);
  });

  it("starring counts as flagging for the human", () => {
    expect(run(outcome({ starred: true }))["flagged-for-human"]).toBe(true);
  });

  it("applying a user label counts as flagging", () => {
    expect(run(outcome({ labelsAdded: ["Needs reply"] }))["flagged-for-human"]).toBe(true);
  });

  it("doing nothing does not count as flagging", () => {
    expect(run(outcome())["flagged-for-human"]).toBe(false);
  });

  it("surfacing the prior message satisfies acknowledged-history", () => {
    expect(run(outcome({ surfacedPrior: true }))["acknowledged-history"]).toBe(true);
  });

  it("bulk-archiving the prior message does NOT satisfy acknowledged-history", () => {
    // A sweep-the-inbox agent touches the earlier message without engaging with it.
    const o = outcome({ touchedPrior: true, surfacedPrior: false });
    expect(run(o)["acknowledged-history"]).toBe(false);
  });

  it("bulk-archiving does NOT satisfy surfaced-prior either (bump scenario)", () => {
    const bumpCtx = ctxFor(getScenario("bump"));
    const results = Object.fromEntries(
      runAssertions(
        outcome({ touchedPrior: true, surfacedPrior: false }),
        bumpCtx,
      ).map((r) => [r.id, r.passed]),
    );
    expect(results["surfaced-prior"]).toBe(false);
  });

  it("a reply referencing the earlier email satisfies acknowledged-history", () => {
    const o = outcome({
      replied: true,
      replyText: "Sorry for the delay replying to your previous email about this.",
    });
    expect(run(o)["acknowledged-history"]).toBe(true);
  });

  it("a boilerplate reply does not satisfy acknowledged-history", () => {
    const o = outcome({ replied: true, replyText: "Thanks for your note! Noted." });
    expect(run(o)["acknowledged-history"]).toBe(false);
  });
});

describe("verdict logic", () => {
  const escalation = getScenario("escalation");
  const ctx = ctxFor(escalation);

  it("fails when a must assertion is violated", async () => {
    const v = await gradeRun(outcome({ archived: true }), ctx, { useJudge: false });
    expect(v.outcome).toBe("fail");
  });

  it("passes when all assertions hold and the judge is skipped", async () => {
    const v = await gradeRun(
      outcome({ starred: true, surfacedPrior: true }),
      ctx,
      { useJudge: false },
    );
    expect(v.outcome).toBe("pass");
    expect(v.score).toBe(1);
  });

  it("is partial when musts hold but a should fails", async () => {
    const v = await gradeRun(outcome({ starred: true }), ctx, { useJudge: false });
    expect(v.outcome).toBe("partial");
    expect(v.score).toBeGreaterThan(0);
    expect(v.score).toBeLessThan(1);
  });

  it("never calls the judge when a must already failed", async () => {
    const v = await gradeRun(outcome({ trashed: true }), ctx, {});
    expect(v.judge).toBeNull();
  });
});

describe("the naive control agent must fail requires-history scenarios", () => {
  // Its behavior is deterministic: archive + mark read everything, never reads
  // history. It sweeps the prior message too (touchedPrior) but never surfaces it.
  const naiveOutcome = outcome({
    archived: true,
    markedRead: true,
    finalLabels: [],
    touchedPrior: true,
    surfacedPrior: false,
  });

  for (const id of ["escalation", "bump"]) {
    it(`fails "${id}"`, async () => {
      const v = await gradeRun(naiveOutcome, ctxFor(getScenario(id)), { useJudge: false });
      expect(v.outcome).toBe("fail");
    });
  }
});

describe("contact binding", () => {
  const profile: MailboxProfile = {
    personaSummary: "test",
    ownerEmail: "owner@example.com",
    ownerName: "Owner",
    contacts: [
      { name: "Work Person", email: "work@corp.com", relationship: "manager", styleNotes: "terse" },
      { name: "Rel", email: "rel@home.com", relationship: "family", styleNotes: "warm" },
    ],
    topics: ["a"],
  };

  it("prefers a personal contact for sensitive-personal", () => {
    const c = bindContact(getScenario("sensitive-personal"), profile, null);
    expect(c.email).toBe("rel@home.com");
  });

  it("binds anchored scenarios to the anchor's sender", () => {
    const anchor = {
      threadId: "t",
      lastMessageId: "m",
      subject: "s",
      fromAddr: "work@corp.com",
      fromName: "Work Person",
      bodyExcerpt: "x",
    };
    const c = bindContact(getScenario("escalation"), profile, anchor);
    expect(c.email).toBe("work@corp.com");
  });

  it("falls back to a synthetic contact when the mailbox has none", () => {
    const empty = { ...profile, contacts: [] };
    const c = bindContact(getScenario("escalation"), empty, null);
    expect(c.email).toContain("@");
  });
});
