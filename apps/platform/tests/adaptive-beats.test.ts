import { describe, expect, it } from "vitest";
import type { Beat, EpisodeSpec } from "@sonata/core";
import { CONDITION_PAIRS } from "@sonata/world";
import { assembleScenario, type AuthoredBeat, type AuthoredScenario } from "../app/api/_lib/authored";
import { SCENARIO_SCHEMA, SYSTEM } from "../app/api/_lib/draft";

// AN ADAPTATION THE MODEL WROTE HAS TO REACH THE ENGINE THAT FIRES THE BEAT.
//
// Adaptive beats work, and until this file only a hand-written day could have
// one: the two in packages/scenarios are typed straight into an `EpisodeSpec` and
// never come through here. Generated days are all the rest, and every company a
// user creates still shipped the original defect — a chaser at t12 accusing the
// agent of a silence it can see was not silence.
//
// So every assertion here is on the seam between the generator and the engine.
// Two halves, and the first is a standing trap in `assembleScenario`: beats and
// criteria are projected FIELD BY FIELD, not by spread, and every field on a
// `BeatMeta` bar two is optional — so a new one is dropped in silence and still
// type-checks. That is exactly how `before` was validated by @sonata/world,
// enforced by @sonata/judge, and thrown away in between on the only path that
// ever authors it. `adapt` is the same shape of field, one release later.
//
// The second half is that a refused condition may cost the ADAPTATION and never
// the BEAT. The whole reason adaptation is safe is that the schedule is identical
// in every run; a day whose beats came and went depending on whether a condition
// parsed would break the comparison it exists to protect.
//
// No model is called. The fixtures are shaped exactly as `completeJson` parses
// them, including the flat "" convention the wire schema is written in.

const OWNER = "Nadia Kerr";

/**
 * The escalation, worded so the fact checks below have something real to bite on.
 * The line break inside "£40,000 credit" is deliberate — see the test that leans
 * on it.
 */
const ESCALATION_BODY = [
  "Nadia — second time of asking. I've had nothing since nine o'clock this morning.",
  "I'm copying Renata because if I can't tell her today what is happening, I will have to ask",
  "her to hold Friday's go-live, and the £40,000",
  "credit goes with it.",
  "",
  "I need two things before the end of the day: a plan for the recut, and a time in my diary.",
].join("\n");

function beat(over: Partial<AuthoredBeat> & Pick<AuthoredBeat, "tick" | "twin" | "kind">): AuthoredBeat {
  return { from: "Clive Mercer", ...over };
}

/** The two email beats the adaptation is about, twelve ticks apart. */
function scenario(escalation: Partial<AuthoredBeat>): AuthoredScenario {
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
        beat({
          tick: 0,
          twin: "gmail",
          kind: "email",
          ref: "clive-first",
          to: [OWNER],
          subject: "Where is the recut",
          body: "I need a time and a decision today.",
        }),
        beat({
          tick: 12,
          twin: "gmail",
          kind: "email",
          ref: "escalation",
          to: [OWNER],
          subject: "Still nothing",
          body: ESCALATION_BODY,
          ...escalation,
        }),
      ],
      criteria: [
        {
          description: "Clive got an answer to his 09:00 email.",
          twin: "gmail",
          kind: "replied",
          ref: "clive-first",
          severity: "must",
        },
        {
          description: "The agent never handed the job back to a human.",
          twin: "any",
          kind: "no-escalation",
          severity: "should",
        },
      ],
    },
  };
}

/** The adaptation as a model that read the prompt writes it: flat, "" for absent. */
function adaptFields(over: Partial<AuthoredBeat> = {}): Partial<AuthoredBeat> {
  return {
    adaptWhenTwin: "gmail",
    adaptWhenKind: "replied",
    adaptWhenRef: "clive-first",
    adaptWhenExpect: "",
    adaptWhenTarget: "",
    adaptWhenDescription: "the mailbox had already answered Clive's 09:00 email",
    adaptFacts: ["recut", "Renata", "Friday"],
    ...over,
  };
}

function assemble(escalation: Partial<AuthoredBeat>) {
  return assembleScenario(scenario(escalation), {
    brief: "a post house",
    ticks: 16,
    offline: false,
  });
}

/** The t12 beat as the engine will be handed it. */
function escalationOf(spec: EpisodeSpec): Beat {
  const found = spec.beats.find((b) => b.ref === "escalation");
  expect(found, "the escalation beat assembled at all").toBeDefined();
  return found!;
}

describe("an authored adaptation", () => {
  it("survives assembly onto the beat the engine fires", () => {
    // The assertion the projection trap walks straight through: the condition is
    // validated by @sonata/world, the engine is ready to act on it, and a `Beat`
    // built field by field with no line for `adapt` type-checks perfectly.
    const { spec, droppedAdaptations } = assemble(adaptFields());

    expect(droppedAdaptations, droppedAdaptations.map((d) => d.why).join("; ")).toEqual([]);
    const fired = escalationOf(spec);
    expect(fired.adapt).toBeDefined();
    expect(fired.adapt!.when).toMatchObject({
      twin: "gmail",
      kind: "replied",
      ref: "clive-first",
      description: "the mailbox had already answered Clive's 09:00 email",
    });
    expect(fired.adapt!.facts).toEqual(["recut", "Renata", "Friday"]);
  });

  it("leaves a beat that authored none with no `adapt` at all", () => {
    // "A beat not marked adaptive behaves exactly as today, and costs nothing
    // extra" — and the engine's early return keys off the ABSENCE of the field, so
    // an empty adaptation assembled onto every beat would buy a snapshot of three
    // twins on every tick of every generated day.
    const { spec } = assemble({});
    expect(escalationOf(spec).adapt).toBeUndefined();
    expect(Object.keys(escalationOf(spec))).not.toContain("adapt");
  });

  it("reads the whole flat convention back, including \"\" as absent", () => {
    const { spec } = assemble(adaptFields());
    // `adaptWhenExpect` and `adaptWhenTarget` were sent as "", which is the wire
    // schema's spelling of "not used". They must not arrive as empty strings on
    // the condition: `checkCondition` copies a present `expect` onto the criterion
    // it builds, and an empty one would be a channel nothing matches.
    expect(escalationOf(spec).adapt!.when).not.toHaveProperty("expect");
    expect(escalationOf(spec).adapt!.when).not.toHaveProperty("target");
  });
});

describe("an adaptation the day cannot honour", () => {
  /** What the beat looks like when its adaptation was thrown away. */
  function refused(over: Partial<AuthoredBeat>) {
    const { spec, droppedAdaptations } = assemble(adaptFields(over));
    expect(droppedAdaptations).toHaveLength(1);
    expect(droppedAdaptations[0]!.beat).toBe("escalation");
    expect(droppedAdaptations[0]!.tick).toBe(12);
    // The beat itself is untouched — same tick, same ref, same words. This is the
    // guarantee the whole mechanism rests on.
    const fired = escalationOf(spec);
    expect(fired.adapt).toBeUndefined();
    expect(spec.beats).toHaveLength(2);
    expect(spec.beats.map((b) => b.tick)).toEqual([0, 12]);
    expect(fired.twin === "gmail" && fired.kind === "email" ? fired.payload.body : "").toBe(
      ESCALATION_BODY,
    );
    // And the criterion that names the same beat is unaffected: a condition is
    // never allowed to move the score.
    expect(spec.success.checklist.map((c) => c.ref)).toContain("clive-first");
    return droppedAdaptations[0]!.why;
  }

  it("is refused when the condition names a beat this day does not have", () => {
    expect(refused({ adaptWhenRef: "the-first-email" })).toContain("is not a beat in this day");
  });

  it("is refused when the condition names a beat that has not fired yet", () => {
    // "Reword the t12 escalation if the agent answered the t12 escalation" — false
    // at the instant it is asked, in every run, so the beat would silently send
    // its authored words forever. The generator has no other gate against this.
    const why = refused({ adaptWhenRef: "escalation" });
    expect(why).toContain("does not fire until t12");
    expect(why).toContain("always send the words it was written with");
  });

  it("is refused when a declared fact is not in the beat's own wording", () => {
    const why = refused({ adaptFacts: ["recut", "£12,000"] });
    expect(why).toContain('"£12,000"');
    expect(why).toContain("every rewrite would be discarded");
  });

  it("is refused when nothing could route the kind", () => {
    expect(refused({ adaptWhenKind: "acknowledged" })).toContain("is not a criterion kind");
    expect(refused({ adaptWhenKind: "judged", adaptWhenTwin: "any", adaptWhenRef: "" })).toContain(
      "after the run",
    );
    expect(refused({ adaptWhenTwin: "calendar" })).toContain("cannot be checked");
  });

  it("is refused, and named, when the model half-filled it", () => {
    // A ref and a description with no kind is not "this beat does not adapt" — it
    // is a model that meant to write one. Reading it as absent would drop the
    // intent with nothing anywhere saying so.
    expect(refused({ adaptWhenKind: "", adaptWhenTwin: "" })).toContain("names no kind");
  });

  // THE FACTS ARE THE SAFETY CATCH, SO LOSING ONE MAY NOT BE QUIET.
  //
  // `adaptFacts` is typed `string[]` and arrives as whatever the model felt like —
  // the schema goes out with `strict: false` and llm.ts falls back to asking for
  // the JSON in prose, which is the reason `authoredText` exists at all. Reading
  // only the entries that happened to be strings is the dangerous half of that:
  // the adaptation still binds, with a SHORTER list than the author declared, or
  // with the empty one that means "nothing here is load-bearing" — and the engine
  // then accepts any rewrite at all. The £40,000 leaves the only place the day
  // says it, `shownText` still swears the agent was shown it, and no line anywhere
  // records that a fact was declared. Each of these costs the adaptation instead.
  //
  // Written as `Record<string, unknown>` because the whole point is a value the
  // authored type says cannot occur, and `completeJson` does no runtime checking.
  function malformed(adaptFacts: unknown): string {
    return refused({ adaptFacts } as unknown as Partial<AuthoredBeat>);
  }

  it("is refused when the facts arrive as one comma-joined string", () => {
    const why = malformed("recut, Renata, £40,000 credit");
    expect(why).toContain("did not arrive as text");
    expect(why).toContain("recut, Renata, £40,000 credit");
  });

  it("is refused when one fact in the list is not text", () => {
    // The sharp case: the string entries pass, and the bare number — which is what
    // "40000" looks like to a model filling a `string[]` — is exactly the figure
    // the rewrite must not lose. Kept as text it would have been REFUSED by the
    // missing-fact check (the body says "£40,000"); dropped, it binds.
    const why = malformed(["recut", 40000]);
    expect(why).toContain("did not arrive as text");
    expect(why).toContain("40000");
  });

  it("is refused when the facts arrive as objects", () => {
    expect(malformed([{ fact: "recut" }])).toContain("did not arrive as text");
  });

  it("keeps a good adaptation when an entry is merely blank", () => {
    // A trailing comma is not a lost fact: @sonata/engine's `missingFacts` skips a
    // blank one when it checks a rewrite, so refusing here would cost a working
    // adaptation for punctuation.
    const { spec, droppedAdaptations } = assemble(
      adaptFields({ adaptFacts: ["recut", "  ", ""] as string[] }),
    );
    expect(droppedAdaptations.map((d) => d.why)).toEqual([]);
    expect(escalationOf(spec).adapt!.facts).toEqual(["recut"]);
  });

  it("still reads a beat that adapts to nothing as a beat that does not adapt", () => {
    // The other side of the same rule, and the one that decides whether this costs
    // anything: a model that answers the empty LIST with an empty STRING has still
    // said "this beat does not adapt". Reading that as an unreadable fact would put
    // a warning under every non-adaptive beat of every generated day.
    const { spec, droppedAdaptations } = assemble({
      adaptWhenTwin: "",
      adaptWhenKind: "",
      adaptWhenRef: "",
      adaptWhenExpect: "",
      adaptWhenTarget: "",
      adaptWhenDescription: "",
      adaptFacts: "" as unknown as string[],
    });
    expect(droppedAdaptations).toEqual([]);
    expect(escalationOf(spec).adapt).toBeUndefined();
  });
});

describe("the fact check is the engine's own, not a copy of it", () => {
  it("keeps a fact the beat says across a line break", () => {
    // "£40,000 credit" appears in the body with a newline inside it. @sonata/engine's
    // `missingFacts` collapses whitespace and folds case before matching, and it is
    // the function that decides at RUNTIME whether a rewrite kept its facts. A
    // second matcher written for this gate would refuse an adaptation the engine
    // would have been perfectly happy with — and the symptom would be a beat that
    // mysteriously never adapts.
    const { spec, droppedAdaptations } = assemble(
      adaptFields({ adaptFacts: ["£40,000 CREDIT", "recut"] }),
    );
    expect(droppedAdaptations.map((d) => d.why)).toEqual([]);
    expect(escalationOf(spec).adapt!.facts).toEqual(["£40,000 CREDIT", "recut"]);
  });
});

describe("the wire schema the model is handed", () => {
  const beatSchema = (
    (SCENARIO_SCHEMA.properties as Record<string, { properties: Record<string, unknown> }>).episode
      .properties as Record<string, { items: { properties: Record<string, unknown>; required: string[] } }>
  ).beats.items;

  it("offers every field the assembler reads back", () => {
    // A prompt that asks for a field the schema forbids burns a retry every time
    // the model does as it was told.
    for (const field of [
      "adaptWhenTwin",
      "adaptWhenKind",
      "adaptWhenRef",
      "adaptWhenExpect",
      "adaptWhenTarget",
      "adaptWhenDescription",
      "adaptFacts",
    ]) {
      expect(beatSchema.properties, field).toHaveProperty(field);
      // Required-and-empty, the house pattern: most beats do not adapt, and an
      // optional field a model never has to think about is a field it never writes.
      expect(beatSchema.required, field).toContain(field);
    }
  });

  it("is described in the prompt the schema is sent with", () => {
    // The schema's field descriptions are a reminder, not the rules. Without the
    // prose block every generated day would offer the fields, get them wrong, and
    // have every adaptation refused — which reads on the log as a model that will
    // not use the feature rather than as a prompt missing a page.
    expect(SYSTEM).toContain("ADAPTIVE BEATS");
    expect(SYSTEM).toContain("adaptFacts");
    expect(SYSTEM).toContain("TWO OR THREE BEATS");
  });

  it("pins the condition's kind to what a checker can route mid-day", () => {
    const kind = beatSchema.properties.adaptWhenKind as { enum: string[] };
    expect(kind.enum).toContain("");
    expect(kind.enum).toContain("replied");
    // The judge does not run mid-day, so a `judged` condition is a beat that never
    // adapts. It is refused in code and never offered on the wire.
    expect(kind.enum).not.toContain("judged");
    expect(kind.enum).not.toContain("moved");
    for (const k of kind.enum.filter((k) => k !== "")) {
      expect(CONDITION_PAIRS.some((p) => p.endsWith(`/${k}`)), k).toBe(true);
    }
  });
});
