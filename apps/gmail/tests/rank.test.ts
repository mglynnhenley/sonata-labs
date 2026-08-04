import { describe, it, expect } from "vitest";
import { FALLBACK_PREFIX, rankStage } from "@/lib/eval/generate/rank";
import type { Candidate, Ranked, StageCtx } from "@/lib/eval/generate/types";
import type { AnchorCriteria, Contact, MailboxProfile, StressScenario } from "@/lib/eval/types";

// Stage 2 (rank) is deterministic and takes no model call, so every case here is
// hand-built Candidate[] plus a fixed clock. No network, no sandbox.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

function candidate(over: Partial<Candidate> & { threadId: string }): Candidate {
  return {
    lastMessageId: `m-${over.threadId}`,
    subject: `subject ${over.threadId}`,
    fromName: "Priya Nair",
    fromAddr: "priya@acme.co",
    internalDate: NOW - 1 * DAY,
    messageCount: 1,
    ownerReplied: false,
    bodyExcerpt: "body",
    ...over,
  };
}

function scenarioWith(anchorCriteria?: AnchorCriteria): StressScenario {
  return {
    id: "test-scenario",
    title: "Test scenario",
    family: "requires-history",
    difficulty: "hard",
    preferAnchor: true,
    anchorCriteria,
    slots: [],
    assertions: [],
    judgeQuestion: "did it go well?",
  };
}

function contact(over: Partial<Contact> & { email: string }): Contact {
  return {
    name: "Priya Nair",
    relationship: "close colleague",
    styleNotes: "terse",
    ...over,
  };
}

function profileWith(contacts: Contact[] = []): MailboxProfile {
  return {
    personaSummary: "an owner",
    ownerEmail: "owner@sandbox.local",
    ownerName: "Owner",
    contacts,
    topics: [],
  };
}

interface Harness {
  ctx: StageCtx;
  said: string[];
}

function harness(scenario: StressScenario, profile: MailboxProfile = profileWith()): Harness {
  const said: string[] = [];
  const ctx: StageCtx = {
    // rank never touches gmail — it works entirely off the Candidate[] it is given.
    gmail: {} as never,
    userId: "me",
    scenario,
    profile,
    now: NOW,
    model: () => undefined,
    say: (msg) => said.push(msg),
  };
  return { ctx, said };
}

async function rank(
  candidates: Candidate[],
  scenario: StressScenario,
  profile?: MailboxProfile,
): Promise<{ ranked: Ranked[]; said: string[] }> {
  const { ctx, said } = harness(scenario, profile);
  const ranked = await rankStage.run(candidates, ctx);
  return { ranked, said };
}

const ids = (ranked: Ranked[]) => ranked.map((r) => r.candidate.threadId);
const find = (ranked: Ranked[], id: string) =>
  ranked.find((r) => r.candidate.threadId === id)!;

describe("rank stage — requireUnanswered", () => {
  // REGRESSION TEST for the core bug this stage exists to fix.
  //
  // The old anchor picker (context.ts, `reduce(max internalDate)`) chose the NEWEST
  // human thread for every scenario, and `findAnchorThread` actively preferred
  // threads the owner had replied to. So `escalation` — whose whole premise is
  // "you never replied to me" — got staged on the mailbox's most-answered thread,
  // and the probe's premise landed on mail that disproves it.
  //
  // With `requireUnanswered`, an OLDER unanswered thread must outrank a NEWER
  // answered one. If this ever flips back, the probe is lying about the mailbox.
  it("ranks an older UNANSWERED thread above a newer ANSWERED one", async () => {
    const oldUnanswered = candidate({
      threadId: "old-silent",
      internalDate: NOW - 120 * DAY,
      ownerReplied: false,
      messageCount: 1,
    });
    const newAnswered = candidate({
      threadId: "new-answered",
      internalDate: NOW - 1 * DAY,
      ownerReplied: true,
      messageCount: 4,
    });

    const { ranked } = await rank([newAnswered, oldUnanswered], scenarioWith({ requireUnanswered: true }));

    expect(ids(ranked)[0]).toBe("old-silent");
    expect(find(ranked, "old-silent").score).toBeGreaterThan(find(ranked, "new-answered").score);
  });

  it("without the criterion the newest thread still wins (old behaviour preserved)", async () => {
    const oldUnanswered = candidate({ threadId: "old-silent", internalDate: NOW - 120 * DAY });
    const newAnswered = candidate({
      threadId: "new-answered",
      internalDate: NOW - 1 * DAY,
      ownerReplied: true,
      messageCount: 4,
    });

    const { ranked } = await rank([oldUnanswered, newAnswered], scenarioWith());

    expect(ids(ranked)[0]).toBe("new-answered");
  });

  it("explains both sides of the criterion in reasons", async () => {
    const { ranked } = await rank(
      [
        candidate({ threadId: "silent" }),
        candidate({ threadId: "answered", ownerReplied: true, messageCount: 3 }),
      ],
      scenarioWith({ requireUnanswered: true }),
    );

    expect(find(ranked, "silent").reasons.join(" ")).toMatch(/never replied — the premise holds/);
    expect(find(ranked, "answered").reasons.join(" ")).toMatch(/premise says nobody answered/);
  });

  it("keeps the disqualified thread in the ranking, just at the bottom", async () => {
    const { ranked } = await rank(
      [
        candidate({ threadId: "answered", ownerReplied: true, messageCount: 5 }),
        candidate({ threadId: "silent", internalDate: NOW - 300 * DAY }),
      ],
      scenarioWith({ requireUnanswered: true }),
    );

    expect(ranked).toHaveLength(2);
    expect(ids(ranked)).toEqual(["silent", "answered"]);
    expect(find(ranked, "answered").score).toBeLessThan(0);
  });
});

describe("rank stage — requireBackAndForth", () => {
  it("prefers a thread the owner replied to with at least two messages", async () => {
    const oneWay = candidate({
      threadId: "one-way",
      internalDate: NOW - 1 * DAY,
      ownerReplied: false,
      messageCount: 3,
    });
    const singleButReplied = candidate({
      threadId: "single-replied",
      internalDate: NOW - 2 * DAY,
      ownerReplied: true,
      messageCount: 1,
    });
    const exchange = candidate({
      threadId: "exchange",
      internalDate: NOW - 60 * DAY,
      ownerReplied: true,
      messageCount: 2,
    });

    const { ranked } = await rank(
      [oneWay, singleButReplied, exchange],
      scenarioWith({ requireBackAndForth: true }),
    );

    expect(ids(ranked)[0]).toBe("exchange");
    expect(find(ranked, "exchange").reasons.join(" ")).toMatch(/two-way exchange — 2 messages/);
  });

  it("disqualifies a one-message thread even when the owner replied, and says why", async () => {
    const { ranked } = await rank(
      [
        candidate({ threadId: "single-replied", ownerReplied: true, messageCount: 1 }),
        candidate({ threadId: "exchange", ownerReplied: true, messageCount: 4, internalDate: NOW - 90 * DAY }),
      ],
      scenarioWith({ requireBackAndForth: true }),
    );

    expect(ids(ranked)[0]).toBe("exchange");
    expect(find(ranked, "single-replied").reasons.join(" ")).toMatch(
      /only 1 message — no exchange to build on/,
    );
  });

  it("disqualifies a thread the owner never replied to, and says why", async () => {
    const { ranked } = await rank(
      [
        candidate({ threadId: "silent", messageCount: 6 }),
        candidate({ threadId: "exchange", ownerReplied: true, messageCount: 2, internalDate: NOW - 90 * DAY }),
      ],
      scenarioWith({ requireBackAndForth: true }),
    );

    expect(ids(ranked)[0]).toBe("exchange");
    expect(find(ranked, "silent").reasons.join(" ")).toMatch(
      /never replied — no exchange to build on/,
    );
  });
});

describe("rank stage — minThreadMessages", () => {
  it("penalises a shallow thread enough that a deeper older one wins", async () => {
    const shallowAndNew = candidate({
      threadId: "shallow",
      internalDate: NOW,
      messageCount: 1,
    });
    const deepAndOld = candidate({
      threadId: "deep",
      internalDate: NOW - 30 * DAY,
      messageCount: 4,
    });

    const { ranked } = await rank(
      [shallowAndNew, deepAndOld],
      scenarioWith({ minThreadMessages: 3 }),
    );

    expect(ids(ranked)[0]).toBe("deep");
    expect(find(ranked, "shallow").reasons.join(" ")).toMatch(
      /1 message\(s\), 2 short of the scenario's floor of 3/,
    );
  });

  it("scales the penalty with the size of the gap", async () => {
    const scenario = scenarioWith({ minThreadMessages: 5 });
    const { ranked } = await rank(
      [
        candidate({ threadId: "one", messageCount: 1 }),
        candidate({ threadId: "four", messageCount: 4 }),
      ],
      scenario,
    );

    expect(find(ranked, "four").score).toBeGreaterThan(find(ranked, "one").score);
  });

  it("adds no penalty reason when the floor is met", async () => {
    const { ranked } = await rank(
      [candidate({ threadId: "deep", messageCount: 3 })],
      scenarioWith({ minThreadMessages: 3 }),
    );

    expect(find(ranked, "deep").reasons.join(" ")).not.toMatch(/short of the scenario's floor/);
  });

  it("is a soft floor — a mailbox of only shallow threads never falls back", async () => {
    const { ranked, said } = await rank(
      [candidate({ threadId: "a", messageCount: 1 }), candidate({ threadId: "b", messageCount: 1 })],
      scenarioWith({ minThreadMessages: 10 }),
    );

    expect(ranked).toHaveLength(2);
    expect(said.join(" ")).not.toContain(FALLBACK_PREFIX);
  });
});

describe("rank stage — preferRelationship", () => {
  const profile = profileWith([
    contact({ email: "boss@acme.co", name: "Dana", relationship: "manager" }),
    contact({ email: "vendor@supplies.example", name: "Sam", relationship: "vendor" }),
  ]);

  it("lifts a matching contact above a more recent non-matching one", async () => {
    const fromVendor = candidate({
      threadId: "vendor-thread",
      fromAddr: "vendor@supplies.example",
      fromName: "Sam",
      internalDate: NOW,
    });
    const fromManager = candidate({
      threadId: "manager-thread",
      fromAddr: "boss@acme.co",
      fromName: "Dana",
      internalDate: NOW - 45 * DAY,
    });

    const { ranked } = await rank(
      [fromVendor, fromManager],
      scenarioWith({ preferRelationship: /manager/i }),
      profile,
    );

    expect(ids(ranked)[0]).toBe("manager-thread");
    expect(find(ranked, "manager-thread").reasons.join(" ")).toMatch(
      /Dana is a manager — the relationship this scenario wants/,
    );
    expect(find(ranked, "vendor-thread").reasons.join(" ")).not.toMatch(
      /the relationship this scenario wants/,
    );
  });

  it("matches case-insensitively on the address when looking the contact up", async () => {
    const { ranked } = await rank(
      [candidate({ threadId: "shouty", fromAddr: "BOSS@ACME.CO", fromName: "Dana" })],
      scenarioWith({ preferRelationship: /manager/i }),
      profile,
    );

    expect(find(ranked, "shouty").reasons.join(" ")).toMatch(/the relationship this scenario wants/);
  });

  it("ignores the preference when no profile contact matches the sender", async () => {
    const { ranked } = await rank(
      [candidate({ threadId: "stranger", fromAddr: "nobody@elsewhere.example" })],
      scenarioWith({ preferRelationship: /manager/i }),
      profile,
    );

    expect(find(ranked, "stranger").reasons.join(" ")).not.toMatch(
      /the relationship this scenario wants/,
    );
  });

  // A /g RegExp carries `lastIndex` between `.test()` calls, so a shared pattern
  // tested across candidates would alternate true/false. Scenarios own the pattern
  // and can't be trusted to omit the flag.
  it("does not let a /g pattern alternate between candidates", async () => {
    const managers = profileWith([
      contact({ email: "a@acme.co", name: "A", relationship: "manager" }),
      contact({ email: "b@acme.co", name: "B", relationship: "manager" }),
      contact({ email: "c@acme.co", name: "C", relationship: "manager" }),
    ]);
    const { ranked } = await rank(
      [
        candidate({ threadId: "a", fromAddr: "a@acme.co", fromName: "A" }),
        candidate({ threadId: "b", fromAddr: "b@acme.co", fromName: "B" }),
        candidate({ threadId: "c", fromAddr: "c@acme.co", fromName: "C" }),
      ],
      scenarioWith({ preferRelationship: /manager/gi }),
      managers,
    );

    for (const r of ranked) {
      expect(r.reasons.join(" ")).toMatch(/the relationship this scenario wants/);
    }
  });
});

describe("rank stage — general quality terms", () => {
  it("penalises automated senders using the whole From header", async () => {
    const human = candidate({
      threadId: "human",
      fromName: "Priya Nair",
      fromAddr: "priya@acme.co",
      internalDate: NOW - 20 * DAY,
    });
    const robot = candidate({
      threadId: "robot",
      fromName: "Booking",
      fromAddr: "noreply@booking.com",
      internalDate: NOW,
    });

    const { ranked } = await rank([robot, human], scenarioWith());

    expect(ids(ranked)[0]).toBe("human");
    expect(find(ranked, "robot").reasons.join(" ")).toMatch(/looks automated/);
  });

  it("lets a vouched-for contact outrank the role-account shape of their address", async () => {
    const profile = profileWith([
      contact({ email: "contact@indie.example", name: "Jo", relationship: "close colleague" }),
    ]);
    const { ranked } = await rank(
      [candidate({ threadId: "jo", fromAddr: "contact@indie.example", fromName: "Jo" })],
      scenarioWith(),
      profile,
    );

    const reasons = find(ranked, "jo").reasons.join(" ");
    expect(reasons).toMatch(/known correspondent \(close colleague\)/);
    expect(reasons).not.toMatch(/shared\/role mailbox/);
  });

  it("marks an unknown role mailbox down", async () => {
    const { ranked } = await rank(
      [candidate({ threadId: "role", fromAddr: "sales@vendor.example", fromName: "Sales" })],
      scenarioWith(),
    );

    expect(find(ranked, "role").reasons.join(" ")).toMatch(/shared\/role mailbox/);
    expect(find(ranked, "role").score).toBeLessThan(0);
  });

  it("clamps future-dated threads to zero age rather than scoring them above now", async () => {
    const { ranked } = await rank(
      [
        candidate({ threadId: "future", internalDate: NOW + 50 * DAY }),
        candidate({ threadId: "now", internalDate: NOW }),
      ],
      scenarioWith(),
    );

    expect(find(ranked, "future").score).toBeCloseTo(find(ranked, "now").score, 10);
    expect(find(ranked, "future").reasons.join(" ")).toMatch(/0d old/);
  });
});

describe("rank stage — reasons", () => {
  it("records one reason per term that fired, each with its own weight", async () => {
    const profile = profileWith([
      contact({ email: "boss@acme.co", name: "Dana", relationship: "manager" }),
    ]);
    const { ranked } = await rank(
      [
        candidate({
          threadId: "rich",
          fromAddr: "boss@acme.co",
          fromName: "Dana",
          messageCount: 2,
          internalDate: NOW - 10 * DAY,
        }),
      ],
      scenarioWith({
        requireUnanswered: true,
        minThreadMessages: 4,
        preferRelationship: /manager/i,
      }),
      profile,
    );

    const [top] = ranked;
    // unanswered + short-thread floor + relationship + recency + depth + known contact
    expect(top.reasons).toHaveLength(6);
    for (const reason of top.reasons) {
      expect(reason).toMatch(/^[+-]\d+(\.\d+)? /);
    }
    const joined = top.reasons.join("\n");
    expect(joined).toMatch(/the premise holds/);
    expect(joined).toMatch(/short of the scenario's floor of 4/);
    expect(joined).toMatch(/the relationship this scenario wants/);
    expect(joined).toMatch(/10d old/);
    expect(joined).toMatch(/2 messages deep/);
    expect(joined).toMatch(/known correspondent/);
  });

  it("always records at least the recency term", async () => {
    const { ranked } = await rank([candidate({ threadId: "plain" })], scenarioWith());
    expect(ranked[0].reasons.length).toBeGreaterThan(0);
    expect(ranked[0].reasons.join(" ")).toMatch(/d old/);
  });

  it("reason weights sum to the reported score", async () => {
    const { ranked } = await rank(
      [candidate({ threadId: "sum", messageCount: 3, internalDate: NOW - 17 * DAY })],
      scenarioWith({ requireUnanswered: true }),
    );

    const sum = ranked[0].reasons.reduce((t, r) => t + Number(r.split(" ")[0]), 0);
    expect(sum).toBeCloseTo(ranked[0].score, 1);
  });
});

describe("rank stage — fallback", () => {
  it("falls back to recency instead of throwing when nothing is unanswered", async () => {
    const candidates = [
      candidate({ threadId: "mid", internalDate: NOW - 10 * DAY, ownerReplied: true, messageCount: 2 }),
      candidate({ threadId: "newest", internalDate: NOW - 1 * DAY, ownerReplied: true, messageCount: 3 }),
      candidate({ threadId: "oldest", internalDate: NOW - 90 * DAY, ownerReplied: true, messageCount: 2 }),
    ];

    const { ranked, said } = await rank(candidates, scenarioWith({ requireUnanswered: true }));

    expect(ids(ranked)).toEqual(["newest", "mid", "oldest"]);
    expect(said.some((s) => s.startsWith(FALLBACK_PREFIX))).toBe(true);
    expect(said.join(" ")).toMatch(/a thread the owner never answered/);
    for (const r of ranked) {
      expect(r.reasons[0]).toMatch(/^fallback: nothing in this mailbox offered/);
      expect(r.score).toBeGreaterThan(0);
    }
    // Scores in the fallback are pure recency, so they descend with age.
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it("falls back when nothing offers a real two-way exchange", async () => {
    const { ranked, said } = await rank(
      [
        candidate({ threadId: "a", internalDate: NOW - 3 * DAY }),
        candidate({ threadId: "b", internalDate: NOW - 1 * DAY }),
      ],
      scenarioWith({ requireBackAndForth: true }),
    );

    expect(ids(ranked)).toEqual(["b", "a"]);
    expect(said.some((s) => s.startsWith(FALLBACK_PREFIX))).toBe(true);
    expect(said.join(" ")).toMatch(/a real two-way exchange/);
  });

  it("names both requirements when a scenario declares two that cannot both hold", async () => {
    const { ranked, said } = await rank(
      [candidate({ threadId: "a" })],
      scenarioWith({ requireUnanswered: true, requireBackAndForth: true }),
    );

    expect(ranked).toHaveLength(1);
    expect(said.join(" ")).toMatch(/never answered and a real two-way exchange/);
  });

  it("does NOT fall back when at least one candidate qualifies", async () => {
    const { ranked, said } = await rank(
      [
        candidate({ threadId: "answered", ownerReplied: true, messageCount: 3, internalDate: NOW }),
        candidate({ threadId: "silent", internalDate: NOW - 200 * DAY }),
      ],
      scenarioWith({ requireUnanswered: true }),
    );

    expect(said.some((s) => s.startsWith(FALLBACK_PREFIX))).toBe(false);
    expect(said.join(" ")).toMatch(/1 meeting a thread the owner never answered/);
    expect(ids(ranked)[0]).toBe("silent");
  });

  // The profile is LLM-derived, so `contacts` can come back missing despite the type.
  it("survives a profile with no contacts array", async () => {
    const profile = { ...profileWith(), contacts: undefined } as unknown as MailboxProfile;
    const { ranked } = await rank(
      [candidate({ threadId: "only" })],
      scenarioWith({ preferRelationship: /manager/i }),
      profile,
    );
    expect(ids(ranked)).toEqual(["only"]);
  });

  it("handles an empty candidate list without throwing", async () => {
    const { ranked, said } = await rank([], scenarioWith({ requireUnanswered: true }));

    expect(ranked).toEqual([]);
    expect(said.some((s) => s.startsWith(FALLBACK_PREFIX))).toBe(true);
    expect(said.join(" ")).toMatch(/runs unanchored/);
  });

  it("handles an empty candidate list with no criteria at all", async () => {
    await expect(rankStage.run([], harness(scenarioWith()).ctx)).resolves.toEqual([]);
  });

  it("survives a scenario with no anchorCriteria field", async () => {
    const { ranked, said } = await rank([candidate({ threadId: "only" })], scenarioWith(undefined));
    expect(ids(ranked)).toEqual(["only"]);
    expect(said.some((s) => s.startsWith(FALLBACK_PREFIX))).toBe(false);
  });
});

describe("rank stage — determinism", () => {
  it("returns the same order for the same mailbox and clock", async () => {
    const candidates = [
      candidate({ threadId: "c", internalDate: NOW - 5 * DAY, messageCount: 2 }),
      candidate({ threadId: "a", internalDate: NOW - 5 * DAY, messageCount: 2 }),
      candidate({ threadId: "b", internalDate: NOW - 2 * DAY, ownerReplied: true, messageCount: 3 }),
    ];
    const scenario = scenarioWith({ requireUnanswered: true });

    const first = await rank(candidates, scenario);
    const second = await rank([...candidates].reverse(), scenario);

    expect(ids(first.ranked)).toEqual(ids(second.ranked));
  });

  it("breaks an exact tie on thread id, not on input order", async () => {
    const scenario = scenarioWith();
    const twins = [
      candidate({ threadId: "zzz", internalDate: NOW - 4 * DAY }),
      candidate({ threadId: "aaa", internalDate: NOW - 4 * DAY }),
    ];

    const { ranked } = await rank(twins, scenario);
    expect(ids(ranked)).toEqual(["aaa", "zzz"]);

    const { ranked: flipped } = await rank([...twins].reverse(), scenario);
    expect(ids(flipped)).toEqual(["aaa", "zzz"]);
  });

  it("reports the winning subject and score on the progress line", async () => {
    const { said } = await rank(
      [candidate({ threadId: "w", subject: "Contract renewal" })],
      scenarioWith(),
    );
    expect(said.join(" ")).toMatch(/ranked 1 candidate\(s\); picked "Contract renewal" \(/);
  });
});
