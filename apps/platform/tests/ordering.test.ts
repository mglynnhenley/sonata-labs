import { describe, expect, it } from "vitest";
import { assembleScenario, type AuthoredScenario } from "../app/api/_lib/authored";

// A DEADLINE THE MODEL WROTE HAS TO REACH THE THING THAT CHECKS IT.
//
// `Criterion.before` is the only field on a criterion that compares two moments
// — "answered the client before he escalates" — and generated scenarios are the
// only way it is ever authored: the shipped days in packages/scenarios are hand
// written and do not go through this file. So every assertion here is on the
// seam between the generator and the checker, and nothing else exercises it.
//
// Both halves of that seam were broken, and neither was visible from either end:
//
//   - `assembleScenario` builds each `Criterion` field by field, and had no line
//     for `before`. Every field on a `Criterion` bar four is optional, so the
//     omission type-checked; @sonata/world validated the deadline, @sonata/judge
//     was ready to enforce it, and the projection in between dropped it on the
//     floor. Exactly the shape of the `coverage` bug in judge-coverage.test.ts,
//     which is why this file exists rather than an assertion tacked onto one.
//   - `bindableBeats` did not carry `tick`, so the gate that refuses a deadline
//     EARLIER than the beat it is about had no tick to compare and passed
//     everything. That one is only reachable from here: `BindableBeat.tick` is
//     optional, so the whole check degrades to "allowed" in silence.
//
// What a deadline MEANS once it arrives — early passes, late fails, and an
// unmeasurable one leaves the score rather than accusing anybody — is pinned in
// packages/judge's checklist.test.ts against that package's own snapshot
// fixtures, and is deliberately not restated here. This file only has to prove
// the criterion gets that far, which is the half nothing else can see.
//
// No model is called. The fixtures are shaped exactly as `completeJson` parses
// them, which is the only reason this can be asserted at all.

const OWNER = "Nadia Kerr";

/**
 * Two email beats far apart on the clock, because the interesting rejection is
 * about the DISTANCE between a beat and a deadline: t1 leaves room before t8,
 * and nothing leaves room before t0.
 */
function scenario(criteria: AuthoredScenario["episode"]["criteria"]): AuthoredScenario {
  return {
    business: {
      name: "Harrow Lane",
      industry: "Post-production",
      size: 14,
      description: "A post house with one client paying for half the year.",
    },
    owner: OWNER,
    cast: [
      { name: OWNER, role: "Managing Director", relationship: "self", voice: "Short lines." },
      {
        name: "Clive Mercer",
        role: "Marketing Director, Kestrel",
        relationship: "client",
        voice: "Warm openings, hard deadlines.",
      },
    ],
    channels: [{ name: "ops", purpose: "Day to day", members: [OWNER] }],
    episode: {
      title: "A client escalates",
      story: "Kestrel opens the day angry.",
      task: "Run Nadia's desk for the day.",
      beats: [
        {
          tick: 1,
          twin: "gmail",
          kind: "email",
          ref: "opener",
          from: "Clive Mercer",
          to: [OWNER],
          subject: "Where is the recut",
          body: "I need a time and a decision today.",
        },
        {
          tick: 8,
          twin: "gmail",
          kind: "email",
          ref: "escalation",
          from: "Clive Mercer",
          to: [OWNER],
          subject: "Still nothing",
          body: "This is the second time I have asked.",
        },
      ],
      criteria,
    },
  };
}

function assemble(criteria: AuthoredScenario["episode"]["criteria"]) {
  return assembleScenario(scenario(criteria), { brief: "a post house", ticks: 12, offline: false });
}

describe("an authored deadline", () => {
  it("survives assembly into the spec the judge is handed", () => {
    const { spec } = assemble([
      {
        description: "Clive had an answer before he escalated.",
        twin: "gmail",
        kind: "replied",
        ref: "opener",
        before: "escalation",
        severity: "must",
      },
    ]);

    const [criterion] = spec.success.checklist;
    expect(criterion, "the criterion bound at all").toBeDefined();
    // The assertion the projection bug walked straight through. Everything else
    // about this criterion arrived intact, which is why nothing else caught it.
    expect(criterion.before).toBe("escalation");
    expect(criterion.ref).toBe("opener");
  });

  it("is thrown out when no agent could ever meet it, naming the beat and the tick", () => {
    // The escalation does not arrive until t8, so "reply to it before t2" is
    // unsatisfiable by construction. Without `tick` on the bindable beats this
    // passes binding and becomes a `must` that every model fails forever, for a
    // reason no one reading the report would guess at.
    const { spec, unbound } = assemble([
      {
        description: "Clive was answered before t2.",
        twin: "gmail",
        kind: "replied",
        ref: "escalation",
        before: "t2",
        severity: "must",
      },
    ]);

    expect(spec.success.checklist).toHaveLength(0);
    expect(unbound).toHaveLength(1);
    expect(unbound[0].why).toContain("t8");
  });

  it("keeps a deadline that is merely tight, so the gate is not just refusing everything", () => {
    // t1 -> t2 is one tick and satisfiable. A gate that rejected this too would
    // pass the test above for the wrong reason.
    const { spec, unbound } = assemble([
      {
        description: "Clive was answered almost immediately.",
        twin: "gmail",
        kind: "replied",
        ref: "opener",
        before: "t2",
        severity: "must",
      },
    ]);

    expect(unbound, unbound.map((u) => u.why).join("; ")).toHaveLength(0);
    expect(spec.success.checklist[0]?.before).toBe("t2");
  });
});
