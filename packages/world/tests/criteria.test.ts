import { describe, expect, it } from "vitest";
import {
  AUTHORABLE_KINDS,
  bindCriteria,
  checklistShortfall,
  criteriaRules,
  type BindingContext,
  type DraftCriterion,
} from "../src/criteria";

// The authoring gate, tested against the checklist that made it necessary.
//
// Run `run_msfxn586_fd15` was stamped "Passed, 100% autonomy" over an agent that
// drafted four refund approvals and sent none of them: three of its four `must`
// criteria named no thread, no channel and no person, so no checker could answer
// them, and the one `should` that WAS decided made the day 1/1. Every one of
// those four is below, verbatim, and every one of them must be refused here —
// before the scenario is stored, rather than on a report someone is sharing.

/** A day with one email beat, one Slack beat, one channel and two people. */
const ctx: BindingContext = {
  beats: [
    { ref: "corsair", twin: "gmail", kind: "email" },
    { ref: "standup", twin: "slack", kind: "message" },
    { ref: "review", twin: "calendar", kind: "invite" },
  ],
  channels: ["support", "#finance"],
  person: (ref) =>
    ({ "chris mott": "chris-mott", "leah ford": "leah-ford", "chris-mott": "chris-mott" })[
      ref.trim().toLowerCase()
    ],
  // The real table, restated: every pair @sonata/judge maps, and nothing else.
  hasChecker: (twin, kind) => {
    if (kind === "no-escalation") return true;
    const by: Record<string, string[]> = {
      gmail: ["replied", "sent", "labelled", "archived", "untouched", "mentions"],
      slack: ["posted", "sent", "replied", "untouched", "mentions"],
      calendar: ["scheduled", "moved", "cancelled", "untouched", "mentions"],
      any: [
        "mentions",
        "replied",
        "sent",
        "posted",
        "labelled",
        "archived",
        "scheduled",
        "moved",
        "cancelled",
        "untouched",
      ],
    };
    return (by[twin] ?? []).includes(kind);
  },
};

function bind(c: Partial<DraftCriterion>): DraftCriterion[] {
  return [{ description: "d", twin: "gmail", kind: "replied", severity: "must", ...c }];
}

function why(c: Partial<DraftCriterion>): string {
  const { unbound } = bindCriteria(bind(c), ctx);
  expect(unbound).toHaveLength(1);
  return unbound[0]!.why;
}

function bound(c: Partial<DraftCriterion>): DraftCriterion {
  const report = bindCriteria(bind(c), ctx);
  expect(report.unbound.map((u) => u.why)).toEqual([]);
  return report.bound[0]!;
}

describe("the checklist that scored 100% of nothing", () => {
  const original: DraftCriterion[] = [
    {
      description: "Corsair Media's double-charge must be replied to",
      twin: "gmail",
      kind: "replied",
      severity: "must",
    },
    {
      description: "Paragon Systems must be flagged to Chris and Leah",
      twin: "slack",
      // The kind the generator actually emitted. It is not a `CriterionKind`, and
      // an unauthorable string has to be refused rather than crash the binder.
      kind: "mentioned" as DraftCriterion["kind"],
      severity: "must",
    },
    {
      description: "James's 4 PM board summary must be answered",
      twin: "gmail",
      kind: "replied",
      severity: "must",
    },
    {
      description: "No customer should be left without a response or status update",
      twin: "any",
      kind: "no-escalation",
      severity: "should",
    },
  ];

  it("refuses every criterion that could not be checked", () => {
    const { bound: kept, unbound } = bindCriteria(original, ctx);
    expect(unbound.map((u) => u.severity)).toEqual(["must", "must", "must"]);
    expect(kept.map((c) => c.kind)).toEqual(["no-escalation"]);
  });

  it("says why, in words the model can act on", () => {
    const { unbound } = bindCriteria(original, ctx);
    expect(unbound[0]!.why).toContain("names no beat ref");
    expect(unbound[1]!.why).toContain('no criterion of kind "mentioned"');
  });

  it("calls the survivor what it is: not enough to score a day", () => {
    const { bound: kept } = bindCriteria(original, ctx);
    expect(checklistShortfall(kept)).toContain("at least 2");
  });
});

describe("what a criterion must name", () => {
  it("wants a beat ref for a reply, and one that exists", () => {
    expect(why({ kind: "replied" })).toContain("names no beat ref");
    expect(why({ kind: "replied", ref: "nope" })).toContain("is not a beat in this day");
    expect(bound({ kind: "replied", ref: "corsair" }).ref).toBe("corsair");
  });

  it("refuses a ref on the wrong surface", () => {
    expect(why({ twin: "gmail", kind: "replied", ref: "standup" })).toContain(
      "is a slack/message beat",
    );
  });

  it("lets an `any` criterion name a beat on whichever surface it is on", () => {
    expect(bound({ twin: "any", kind: "replied", ref: "standup" }).ref).toBe("standup");
    expect(why({ twin: "any", kind: "replied", ref: "review" })).toContain(
      "is a calendar/invite beat",
    );
  });

  it("wants a person in the cast for a send", () => {
    expect(why({ kind: "sent" })).toContain("names no recipient");
    expect(why({ kind: "sent", target: "Jane Nobody" })).toContain("is not in the cast");
    // Stored as the id the judge resolves addresses from, not as the name.
    expect(bound({ kind: "sent", target: "Chris Mott" }).target).toBe("chris-mott");
  });

  it("wants a channel this world has, written either way round", () => {
    expect(why({ twin: "slack", kind: "posted" })).toContain("names no channel");
    expect(why({ twin: "slack", kind: "posted", expect: "#billing" })).toContain(
      "is not a channel in this world",
    );
    expect(bound({ twin: "slack", kind: "posted", expect: "#Support" }).expect).toBe("support");
    // The judge reads `expect ?? target` for a channel; both spellings bind, and
    // both are stored in the one field.
    const viaTarget = bound({ twin: "slack", kind: "posted", target: "finance" });
    expect(viaTarget.expect).toBe("finance");
    expect(viaTarget.target).toBeUndefined();
  });

  it("wants a phrase that could actually appear in what the agent wrote", () => {
    expect(why({ twin: "any", kind: "mentions" })).toContain("names no phrase");
    expect(why({ twin: "any", kind: "mentions", expect: "a" })).toContain("too short");
    expect(
      why({ twin: "any", kind: "mentions", expect: "the survey moved to Thursday instead" }),
    ).toContain("prose, not a phrase");
    // The one a real generation produced: five bare words nobody types in order.
    expect(
      why({ twin: "any", kind: "mentions", expect: "structural facade mechanical roof" }),
    ).toContain("string of ordinary words");
    expect(bound({ twin: "any", kind: "mentions", expect: "22:40" }).expect).toBe("22:40");
    expect(bound({ twin: "gmail", kind: "labelled", ref: "corsair", expect: "Refunds" }).expect).toBe(
      "Refunds",
    );
  });
});

describe("kinds nothing can decide", () => {
  // All three are diffed against the snapshot taken before the first beat fires,
  // so a beat's own thread or event was never in the "before" they compare with.
  for (const kind of ["untouched", "moved", "cancelled"] as const) {
    it(`refuses ${kind}, whatever it names`, () => {
      expect(why({ twin: "calendar", kind, ref: "review" })).toContain(`\`${kind}\``);
    });
  }

  it("keeps them out of the schema the model is given", () => {
    expect(AUTHORABLE_KINDS).not.toContain("untouched");
    expect(AUTHORABLE_KINDS).not.toContain("moved");
    expect(AUTHORABLE_KINDS).not.toContain("cancelled");
    expect(AUTHORABLE_KINDS).toContain("replied");
  });

  it("refuses a no-escalation narrowed to one person", () => {
    // The run records what was said, not who it went to, so the narrower claim
    // comes back undecided — which is another undecided `must`.
    expect(why({ twin: "any", kind: "no-escalation", target: "Chris Mott" })).toContain(
      "cannot be narrowed to one person",
    );
    expect(bound({ twin: "any", kind: "no-escalation" }).target).toBeUndefined();
  });
});

describe("a checklist that scores the day", () => {
  const settled: DraftCriterion = {
    description: "d",
    twin: "gmail",
    kind: "replied",
    ref: "corsair",
    severity: "must",
  };
  const prose: DraftCriterion = {
    description: "d",
    twin: "any",
    kind: "judged",
    severity: "must",
  };

  it("passes when two criteria bind and one of them is a must", () => {
    expect(checklistShortfall([settled, { ...settled, severity: "should" }])).toBeUndefined();
  });

  it("fails when everything is prose for the judge", () => {
    expect(checklistShortfall([prose, prose, prose])).toContain("only 0 of 3");
  });

  it("fails when every must is prose for the judge", () => {
    const shortfall = checklistShortfall([
      prose,
      { ...settled, severity: "should" },
      { ...settled, severity: "should" },
    ]);
    expect(shortfall).toContain("every `must`");
  });
});

describe("the prompt says what the binder enforces", () => {
  const rules = criteriaRules({
    beats: [{ ref: "corsair", twin: "gmail", kind: "email" }],
    channels: ["support"],
    people: ["Chris Mott"],
  });

  it("shows the model the refs, channels and people it may name", () => {
    expect(rules).toContain("corsair — the gmail email beat");
    expect(rules).toContain("#support");
    expect(rules).toContain("Chris Mott");
  });

  it("warns about the kinds the binder will refuse", () => {
    expect(rules).toContain("untouched, moved, cancelled");
    expect(rules).toContain("max 4 words");
  });
});
