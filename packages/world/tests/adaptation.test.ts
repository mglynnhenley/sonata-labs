import { describe, expect, it } from "vitest";
import {
  adaptationRules,
  bindAdaptation,
  CONDITION_KINDS,
  CONDITION_PAIRS,
  type AdaptationContext,
  type AdaptingBeat,
  type DraftAdaptation,
} from "../src/criteria";

// THE GATE ON AN ADAPTIVE BEAT, AND WHY EVERY REFUSAL IN IT IS ABOUT SILENCE.
//
// An adaptation is a chaser agreeing not to be factually wrong about the agent.
// Every way of writing a broken one produces the SAME symptom as writing none at
// all: the beat fires on its tick, says exactly what it was authored with, and
// looks on the timeline like a scripted moment that was never marked adaptive.
// There is no crash, no missing row and no failed criterion to notice — so a
// condition that could never be true has to be refused at authoring, out loud,
// or it is indistinguishable from the defect it was added to fix.
//
// The other half of the design is that a condition is a `Criterion` with the
// score taken off, and goes to the same RULES table. That is what these tests
// pin: not a second reading of "replied", the first one.

/** A day with two email beats far apart, a Slack beat, one channel, two people. */
const day: Omit<AdaptationContext, "missingFacts"> = {
  beats: [
    { ref: "clive-first", twin: "gmail", kind: "email", tick: 0 },
    { ref: "standup", twin: "slack", kind: "message", tick: 1 },
    { ref: "escalation", twin: "gmail", kind: "email", tick: 12 },
    { ref: "review", twin: "calendar", kind: "invite", tick: 9 },
  ],
  channels: ["launch-kestrel", "#ops"],
  person: (ref) =>
    ({ "renata voss": "renata-voss", "renata-voss": "renata-voss" })[ref.trim().toLowerCase()],
  hasChecker: (twin, kind) => {
    if (kind === "no-escalation") return true;
    const by: Record<string, string[]> = {
      gmail: ["replied", "sent", "labelled", "archived", "mentions"],
      slack: ["posted", "sent", "replied", "mentions"],
      calendar: ["scheduled", "mentions"],
      any: ["mentions", "replied", "sent", "posted", "labelled", "archived", "scheduled"],
    };
    return (by[twin] ?? []).includes(kind);
  },
};

/**
 * The fact matcher, restated. The real one is @sonata/engine's `missingFacts`,
 * which this package may not import and deliberately does not copy — it is
 * injected, exactly as `hasChecker` is. What that injection is worth is asserted
 * on the only path that supplies the real one, in the platform's
 * adaptive-beats.test.ts; here it only has to be a substring match so the rest of
 * the gate can be exercised.
 */
const ctx: AdaptationContext = {
  ...day,
  missingFacts: (text, facts) =>
    facts.filter((f) => f.trim() && !text.toLowerCase().includes(f.trim().toLowerCase())),
};

/** Clive's t12 escalation, as `clientEscalation.ts` actually writes it. */
const ESCALATION: AdaptingBeat = {
  twin: "gmail",
  kind: "email",
  tick: 12,
  words: [
    "Nadia — second time of asking. I've had nothing since nine o'clock this morning.",
    "I'm copying Renata because if I can't tell her today what is happening, I'm going to have",
    "to ask her to hold Friday's go-live.",
    "I need two things before the end of the day: a plan for the recut, and a time in my diary.",
  ].join("\n"),
};

function adaptation(over: Partial<DraftAdaptation["when"]> = {}, facts: string[] = []): DraftAdaptation {
  return {
    when: {
      description: "the mailbox had already answered Clive's 09:00 email",
      twin: "gmail",
      kind: "replied",
      ref: "clive-first",
      ...over,
    },
    facts,
  };
}

function why(adapt: DraftAdaptation, beat: AdaptingBeat = ESCALATION): string {
  const outcome = bindAdaptation(adapt, beat, ctx);
  expect(outcome, "expected this adaptation to be refused").not.toHaveProperty("bound");
  return "why" in outcome ? outcome.why : "";
}

function bound(adapt: DraftAdaptation, beat: AdaptingBeat = ESCALATION): DraftAdaptation {
  const outcome = bindAdaptation(adapt, beat, ctx);
  expect("why" in outcome ? outcome.why : "").toBe("");
  return "bound" in outcome ? outcome.bound : adapt;
}

describe("an adaptation the day can actually use", () => {
  it("binds Clive's escalation, facts and all", () => {
    const it_ = bound(adaptation({}, ["recut", "Renata", "Friday"]));
    expect(it_.when.kind).toBe("replied");
    expect(it_.when.ref).toBe("clive-first");
    expect(it_.facts).toEqual(["recut", "Renata", "Friday"]);
  });

  it("normalizes the condition exactly as the same words on a criterion would", () => {
    // A condition that reached the checker saying "#OPS" or "Renata Voss" would be
    // asking a question of a channel and a person that do not exist under those
    // names — which comes back undecided, and undecided fires the script.
    expect(bound(adaptation({ twin: "slack", kind: "posted", ref: undefined, expect: "#OPS" })).when.expect).toBe(
      "ops",
    );
    expect(
      bound(adaptation({ kind: "sent", ref: undefined, target: "Renata Voss" })).when.target,
    ).toBe("renata-voss");
  });

  it("takes an empty facts list as the real statement it is", () => {
    // "Nothing here is load-bearing" — the rewrite is then accepted on its face.
    // Refusing this would force an author to invent a fact to protect.
    expect(bound(adaptation()).facts).toEqual([]);
  });
});

describe("a condition that names something this day does not have", () => {
  it("refuses a beat ref that is not in the day, and lists the ones that are", () => {
    const refused = why(adaptation({ ref: "nope" }));
    expect(refused).toContain("is not a beat in this day");
    expect(refused).toContain("clive-first");
  });

  it("refuses a condition with no ref at all where the check needs one", () => {
    expect(why(adaptation({ ref: undefined }))).toContain("names no beat ref");
  });

  it("refuses a ref on the wrong surface", () => {
    expect(why(adaptation({ ref: "standup" }))).toContain("is a slack/message beat");
  });

  it("refuses a person the cast does not have", () => {
    expect(why(adaptation({ kind: "sent", ref: undefined, target: "Jane Nobody" }))).toContain(
      "is not in the cast",
    );
  });
});

describe("a condition no checker can route", () => {
  it("refuses a (twin, kind) pair nothing implements", () => {
    expect(why(adaptation({ twin: "calendar", kind: "replied", ref: undefined }))).toContain(
      "cannot be checked",
    );
  });

  it("refuses `judged`, which is answered after the run and not during it", () => {
    // The subtlest of the five, and the one that looks most like a working
    // adaptation: `judged` binds perfectly well as a CRITERION, so the criteria
    // gate would wave it through. Mid-day nothing answers it, the beat fires as
    // authored, and it does that in every run of every model.
    const refused = why(adaptation({ twin: "any", kind: "judged", ref: undefined }));
    expect(refused).toContain("after the run");
    expect(refused).toContain("always send its authored words");
  });

  it("never offers `judged` in the vocabulary a condition is written from", () => {
    expect(CONDITION_KINDS).not.toContain("judged");
    expect(CONDITION_KINDS).toContain("replied");
    expect(CONDITION_PAIRS).not.toContain("any/judged");
    expect(CONDITION_PAIRS).toContain("gmail/replied");
  });
});

describe("a condition that could never have been true by the time it is asked", () => {
  it("refuses a beat that fires on the same tick as the one adapting on it", () => {
    // Beats land at the top of a tick and the agent acts at the bottom of one, so
    // there is no moment between these two for the agent to have acted in.
    const refused = why(adaptation({ ref: "escalation" }));
    expect(refused).toContain("does not fire until t12");
    expect(refused).toContain("always send the words it was written with");
  });

  it("refuses a beat that fires later than the one adapting on it", () => {
    expect(why(adaptation({ ref: "escalation" }), { ...ESCALATION, tick: 4 })).toContain(
      "does not fire until t12",
    );
  });

  it("keeps one that is merely tight, so the gate is not just refusing everything", () => {
    // t1 -> t2 is one tick and satisfiable: the agent reads the standup at t1 and
    // answers before the beat at t2 fires.
    const tight = bound(
      adaptation({ twin: "slack", kind: "replied", ref: "standup" }),
      { twin: "slack", kind: "message", tick: 2, words: "any word on the recut? Friday is close" },
    );
    expect(tight.when.ref).toBe("standup");
  });
});

describe("facts the beat's own wording does not carry", () => {
  it("refuses them, and says every rewrite would be thrown away", () => {
    const refused = why(adaptation({}, ["recut", "£40,000"]));
    expect(refused).toContain('"£40,000"');
    expect(refused).not.toContain('"recut"');
    expect(refused).toContain("every rewrite would be discarded");
  });

  it("keeps facts the beat does carry", () => {
    expect(bound(adaptation({}, ["recut", "Friday"])).facts).toEqual(["recut", "Friday"]);
  });

  it("drops blank entries rather than refusing over them", () => {
    // The engine skips a blank fact when it checks a rewrite, so refusing one here
    // would cost a good adaptation for a trailing comma in a list.
    expect(bound(adaptation({}, ["recut", "  ", ""])).facts).toEqual(["recut"]);
  });
});

describe("a beat with nothing to reword", () => {
  it("refuses an adaptation on a calendar invite", () => {
    // `beatWords` in @sonata/engine reads a body off an email and a text off a
    // Slack message, and nothing off anything else. An adaptation here is not
    // wrong so much as inert: the rewrite is never even attempted.
    const refused = why(adaptation(), { twin: "calendar", kind: "invite", tick: 12, words: "" });
    expect(refused).toContain("carries no wording to reword");
    expect(refused).toContain("exactly as authored in every run");
  });
});

describe("the prompt says what the gate enforces", () => {
  const rules = adaptationRules();

  it("says what an adaptation is FOR, in the terms of the defect", () => {
    expect(rules).toContain("nothing since nine");
    expect(rules).toContain("CHASES");
  });

  it("gives the worked example with the fields named as the schema names them", () => {
    expect(rules).toContain("adaptWhenTwin");
    expect(rules).toContain("adaptWhenKind");
    expect(rules).toContain("adaptWhenRef");
    expect(rules).toContain("adaptWhenDescription");
    expect(rules).toContain("adaptFacts");
    expect(rules).toContain("clive-first");
  });

  it("caps how many beats may use it", () => {
    expect(rules).toContain("TWO OR THREE BEATS");
    expect(rules).toContain("Never on every beat");
  });

  it("warns about every refusal before the model can earn one", () => {
    // A validator that rejects something the prompt never mentioned burns retries,
    // and there are five ways to be rejected here.
    expect(rules).toContain("MUST FIRE ON AN EARLIER TICK");
    expect(rules).toContain("WORD FOR WORD");
    expect(rules).toContain("no wording to reword");
    expect(rules).toContain('Never "judged"');
    // Off the same table the gate reads, so the two cannot drift apart.
    expect(rules).toContain("gmail/replied");
    expect(rules).not.toContain("any/judged");
  });
});
