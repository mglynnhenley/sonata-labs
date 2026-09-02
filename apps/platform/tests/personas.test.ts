import { describe, expect, it } from "vitest";
import { danglingRefs, type DirectorPersona } from "@sonata/core";
import { directorSystemPrompt } from "@sonata/engine";
import { checklistShortfall } from "@sonata/world";
import {
  assembleScenario,
  RELATIONSHIPS,
  type AuthoredPerson,
  type AuthoredScenario,
} from "../app/api/_lib/authored";
import { SCENARIO_SCHEMA } from "../app/api/_lib/draft";
import { TEMPLATES, assembleTemplate } from "../app/api/_lib/templates";

// A GENERATED PERSON HAS TO BE A PERSON.
//
// Every persona in a generated day used to be three if-statements on
// `relationship` — 0.7 or 0.85, 2 ticks or 1 — with no brief at all, so the only
// thing separating six people out of the same company was a note on how they
// typed. The hand-written days in packages/scenarios have always had real ones
// ("Wants a time and a decision, in that order… never says which of Nadia's
// meetings should move"), and this is the generator being held to that bar.
//
// The other half is that a model's answer is not trusted on the way through. No
// model can be called from a test, so the fixtures here are shaped exactly like
// the JSON `completeJson` parses — including the shapes a model actually
// produces when it is wrong: a responsiveness of 1.4, a delay of -3, a brief
// that is one space.

const OWNER = "Nadia Kerr";

function person(over: Partial<AuthoredPerson> & Pick<AuthoredPerson, "name" | "relationship">): AuthoredPerson {
  return {
    role: "Producer",
    voice: "Short lines, no sign-off.",
    ...over,
  };
}

/** The cast as a model that read the prompt would write it: everyone has a brief. */
const AUTHORED_CAST: AuthoredPerson[] = [
  person({ name: OWNER, relationship: "self", role: "Managing Director" }),
  person({
    name: "Clive Mercer",
    relationship: "client",
    role: "Marketing Director, Kestrel",
    voice: "Warm openings, hard deadlines, one paragraph.",
    brief:
      "Wants a time and a decision, in that order. Accepts a specific plan immediately and warmly; will not accept 'we're looking at it'. Never proposes a slot himself and never says which of Nadia's meetings should move.",
    responsiveness: 0.9,
    replyDelayTicks: 1,
  }),
  person({
    name: "Bea Voss",
    relationship: "peer",
    role: "Account Lead",
    brief:
      "Relieved by anything concrete. Will confirm to the client only what she has been told in writing, and will not move the board forecast for anyone.",
    responsiveness: 0.85,
    replyDelayTicks: 0,
  }),
  person({
    name: "Moira Kelb",
    relationship: "vendor",
    role: "Press Office",
    brief: "Answers only about the embargo clock. Holds the 16:00 send regardless.",
    responsiveness: 0.6,
    replyDelayTicks: 2,
  }),
];

/** The same cast from a model that answered with none of the new fields. */
const BARE_CAST: AuthoredPerson[] = AUTHORED_CAST.map((p) => ({
  name: p.name,
  role: p.role,
  relationship: p.relationship,
  voice: p.voice,
}));

function scenario(over: Partial<AuthoredScenario> = {}): AuthoredScenario {
  return {
    business: {
      name: "Harrow Lane",
      industry: "Post-production",
      size: 14,
      description: "A post house with one client paying for half the year.",
    },
    owner: OWNER,
    cast: AUTHORED_CAST,
    channels: [
      { name: "ops", purpose: "Day to day", members: [OWNER, "Bea Voss"] },
    ],
    offLimits: [
      "Nobody mentions that the grade review and the Q3 forecast are both at 14:00 — the clash exists on the calendar and has to be found there.",
      "Nobody offers to move a meeting, and nobody proposes a new time for the client call.",
    ],
    style: "Agency register. Slack is lower case, fragmentary, two lines at most.",
    episode: {
      title: "A client escalates while you're double-booked",
      story: "Kestrel opens the day angry and the answer is in #ops.",
      task: "Run Nadia's desk for the day.",
      beats: [
        {
          tick: 1,
          twin: "gmail",
          kind: "email",
          ref: "escalation",
          from: "Clive Mercer",
          to: [OWNER],
          subject: "Where is the recut",
          body: "This is the second time. I need a time and a decision today.",
        },
        {
          tick: 2,
          twin: "slack",
          kind: "message",
          from: "Bea Voss",
          channel: "ops",
          text: "grade is locked until 15:00, machine's booked",
        },
      ],
      criteria: [
        {
          description: "Clive had a written answer before the end of the day.",
          twin: "gmail",
          kind: "replied",
          ref: "escalation",
          severity: "must",
        },
        {
          description: "The studio was told what was decided.",
          twin: "slack",
          kind: "posted",
          expect: "ops",
          severity: "should",
        },
      ],
    },
    ...over,
  };
}

function assemble(over: Partial<AuthoredScenario> = {}) {
  return assembleScenario(scenario(over), { brief: "a post house", ticks: 12, offline: false });
}

function persona(personas: readonly DirectorPersona[], id: string): DirectorPersona {
  const found = personas.find((p) => p.personId === id);
  expect(found, `no persona for ${id}`).toBeDefined();
  return found!;
}

describe("authored characters", () => {
  it("carries every authored brief through to the persona the director reads", () => {
    const { spec } = assemble();

    expect(persona(spec.director.personas, "clive-mercer").brief).toBe(
      "Wants a time and a decision, in that order. Accepts a specific plan immediately and warmly; will not accept 'we're looking at it'. Never proposes a slot himself and never says which of Nadia's meetings should move.",
    );
    expect(persona(spec.director.personas, "bea-voss").brief).toContain(
      "only what she has been told in writing",
    );
    expect(persona(spec.director.personas, "moira-kelb").brief).toContain("embargo clock");

    // The whole point of the field is that it reaches the model that writes these
    // people. Asserting on the spec alone would pass just as happily if the
    // engine had never rendered it.
    const prompt = directorSystemPrompt(spec);
    expect(prompt).toContain("Never proposes a slot himself");
    expect(prompt).toContain("Agency register");
  });

  it("uses the authored numbers rather than the two ternaries", () => {
    const { spec } = assemble();
    // A client is 0.7/2 by derivation; this one was authored 0.9/1, and a
    // scenario where the authored value quietly lost to the derivation would be
    // indistinguishable from this whole feature not existing.
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.responsiveness).toBe(0.9);
    expect(clive.replyDelayTicks).toBe(1);
    expect(persona(spec.director.personas, "bea-voss").replyDelayTicks).toBe(0);
    expect(persona(spec.director.personas, "moira-kelb").responsiveness).toBe(0.6);
  });

  it("keeps the standing prohibitions and adds the authored ones", () => {
    const { spec } = assemble();
    // The two standing lines are not filler to be replaced: they are what stops
    // the world doing the agent's job, and a model writing off-limits for a post
    // house writes about the post house. Both must be in the director's prompt.
    expect(spec.director.offLimits[0]).toContain("Never tell the agent what to do next");
    expect(spec.director.offLimits[1]).toContain("Never volunteer a fact");
    expect(spec.director.offLimits).toContain(
      "Nobody offers to move a meeting, and nobody proposes a new time for the client call.",
    );
    expect(spec.director.style).toBe(
      "Agency register. Slack is lower case, fragmentary, two lines at most.",
    );
  });

  it("does not repeat a standing prohibition the author wrote out again", () => {
    const { spec } = assemble({
      offLimits: ["Never volunteer a fact it has not asked for.", "  ", "Nobody chases."],
    });
    const volunteering = spec.director.offLimits.filter((o) => o.startsWith("Never volunteer a fact"));
    expect(volunteering).toHaveLength(1);
    expect(spec.director.offLimits).toContain("Nobody chases.");
    // A blank line renders as an empty bullet, which reads to a model as a rule
    // it failed to receive.
    expect(spec.director.offLimits.some((o) => o.trim() === "")).toBe(false);
  });
});

describe("a model response with none of it", () => {
  it("still assembles a day that runs and scores", () => {
    const bare = assembleScenario(
      // Exactly what an older model, or a truncated answer, hands back: the cast
      // has voices and nothing else, and there is no world-level direction.
      { ...scenario(), cast: BARE_CAST, offLimits: undefined, style: undefined },
      { brief: "a post house", ticks: 12, offline: false },
    );

    expect(bare.unbound).toHaveLength(0);
    expect(checklistShortfall(bare.spec.success.checklist)).toBeUndefined();
    expect(danglingRefs(bare.spec)).toHaveLength(0);
    expect(bare.spec.director.personas).toHaveLength(BARE_CAST.length - 1);
    expect(bare.spec.director.offLimits).toHaveLength(2);
    expect(bare.spec.director.style).toBe(
      "Short, busy, specific. Write like someone with six other things open.",
    );
  });

  it("falls back to the relationship derivation, person by person", () => {
    const { spec } = assembleScenario(
      { ...scenario(), cast: BARE_CAST },
      { brief: "a post house", ticks: 12, offline: false },
    );
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.responsiveness).toBe(0.7);
    expect(clive.replyDelayTicks).toBe(2);
    expect(clive.brief).toBeUndefined();

    const bea = persona(spec.director.personas, "bea-voss");
    expect(bea.responsiveness).toBe(0.85);
    expect(bea.replyDelayTicks).toBe(1);
  });

  it("falls back one field at a time, not all or nothing", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        // A brief and nothing else — the common half-answer.
        person({ name: "Clive Mercer", relationship: "client", brief: "Wants a date." }),
      ],
    });
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.brief).toBe("Wants a date.");
    expect(clive.responsiveness).toBe(0.7);
    expect(clive.replyDelayTicks).toBe(2);
  });
});

describe("nothing unvalidated reaches the engine", () => {
  it("clamps numbers a model had no business writing", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        person({ name: "Clive Mercer", relationship: "client", responsiveness: 1.4, replyDelayTicks: 40 }),
        person({ name: "Bea Voss", relationship: "peer", responsiveness: -3, replyDelayTicks: -2 }),
        person({ name: "Moira Kelb", relationship: "vendor", responsiveness: 0.5, replyDelayTicks: 1.6 }),
      ],
    });
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.responsiveness).toBe(1);
    // Four ticks, not forty: a persona that answers after the day has ended is a
    // character the transcript simply never contains.
    expect(clive.replyDelayTicks).toBe(4);

    const bea = persona(spec.director.personas, "bea-voss");
    expect(bea.responsiveness).toBe(0);
    expect(bea.replyDelayTicks).toBe(0);
    expect(persona(spec.director.personas, "moira-kelb").replyDelayTicks).toBe(2);
  });

  it("reads an empty string as absent, not as zero and not as an instruction", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        // The house convention for a field a model has nothing to say about is
        // "". `Number("")` is 0, so the naive read turns "no answer" into a
        // client who never replies — a cast member missing from the day with
        // nothing anywhere to say why.
        {
          ...person({ name: "Clive Mercer", relationship: "client" }),
          brief: "   ",
          responsiveness: "" as unknown as number,
          replyDelayTicks: "" as unknown as number,
        },
      ],
    });
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.responsiveness).toBe(0.7);
    expect(clive.replyDelayTicks).toBe(2);
    expect("brief" in clive).toBe(false);
    expect(directorSystemPrompt(spec)).not.toContain("standing instruction:");
  });

  it("accepts a numeral a model sent as a string", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        {
          ...person({ name: "Clive Mercer", relationship: "client" }),
          responsiveness: "0.55" as unknown as number,
          replyDelayTicks: "3" as unknown as number,
        },
      ],
    });
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.responsiveness).toBe(0.55);
    expect(clive.replyDelayTicks).toBe(3);
  });

  it("survives a model that answered a string field with something else", () => {
    // Not hypothetical model-bashing: the schema goes out with `strict: false`,
    // and llm.ts re-asks in prose when a provider cannot do structured outputs,
    // so nothing on the wire enforces a type. A list-of-rules field coming back
    // as `[{rule}]` or as one newline-separated string is the ordinary way this
    // goes wrong — and `.trim()` on it threw out of the whole assembler, so
    // draftScenario swallowed a perfectly good cast, day and checklist and
    // handed back a template whose stated reason was "line.trim is not a
    // function". One mistyped line must cost that line.
    const objectLines = assemble({
      offLimits: [{ rule: "nobody coaches the agent" }] as unknown as string[],
    });
    expect(objectLines.spec.director.offLimits).toEqual([
      "Never tell the agent what to do next, or name the action it should take.",
      "Never volunteer a fact it has not asked for.",
    ]);

    const oneString = assemble({ offLimits: "nobody coaches the agent" as unknown as string[] });
    expect(oneString.spec.director.offLimits).toHaveLength(2);

    const listStyle = assemble({ style: ["terse"] as unknown as string });
    expect(listStyle.spec.director.style).toBe(
      "Short, busy, specific. Write like someone with six other things open.",
    );

    const numberedBrief = assemble({
      cast: [AUTHORED_CAST[0]!, { ...person({ name: "Clive Mercer", relationship: "client" }), brief: 3 as unknown as string }],
    });
    expect("brief" in persona(numberedBrief.spec.director.personas, "clive-mercer")).toBe(false);
    // The rest of the day is untouched — which is the whole point of dropping
    // the field rather than the generation.
    expect(checklistShortfall(numberedBrief.spec.success.checklist)).toBeUndefined();
    expect(danglingRefs(numberedBrief.spec)).toHaveLength(0);
  });

  it("keeps an outsider off Slack whatever case the model wrote them in", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        // The shape a model writes when it is echoing the role it just typed.
        // This matched neither arm of the old ternary, so the outside client was
        // handed the company Slack — where the fact the day hides lives.
        person({ name: "Clive Mercer", relationship: "Client" }),
        person({ name: "Moira Kelb", relationship: " VENDOR " }),
      ],
    });
    const clive = persona(spec.director.personas, "clive-mercer");
    expect(clive.surfaces).toEqual(["gmail"]);
    expect(persona(spec.director.personas, "moira-kelb").surfaces).toEqual(["gmail"]);
    // The same word, so the same derived numbers — a capitalised client used to
    // get a colleague's 0.85/1 as well as a colleague's Slack account.
    expect(clive.responsiveness).toBe(0.7);
    expect(clive.replyDelayTicks).toBe(2);
  });

  it("keeps a candidate outside too", () => {
    // An interviewee with a competing offer is as outside the company as a
    // client. The hand-written packages/scenarios day has always had them on
    // ["gmail"]; the derivation used to disagree, and the shipped
    // candidate-scheduling template put Amara in #hiring, where the debrief and
    // the rest of the loop are.
    const { spec } = assemble({
      cast: [AUTHORED_CAST[0]!, person({ name: "Amara Diallo", relationship: "candidate" })],
    });
    expect(persona(spec.director.personas, "amara-diallo").surfaces).toEqual(["gmail"]);
  });

  it("has decided about every relationship it offers the model", () => {
    // The drift this catches: a word added to the schema's enum that
    // `surfacesFor` has never heard of falls through to "internal", which is a
    // Slack account granted by nobody. Both lists come from `RELATIONSHIPS`, and
    // this is the assertion that they still do.
    const cast = (
      SCENARIO_SCHEMA.properties as {
        cast: { items: { properties: { relationship: { enum?: string[] } } } };
      }
    ).cast;
    expect(cast.items.properties.relationship.enum).toEqual([...RELATIONSHIPS]);

    const outsiders = new Set(["client", "vendor", "candidate"]);
    for (const relationship of RELATIONSHIPS) {
      if (relationship === "self") continue;
      const { spec } = assemble({
        cast: [AUTHORED_CAST[0]!, person({ name: "Sam Reed", relationship })],
      });
      expect(persona(spec.director.personas, "sam-reed").surfaces, relationship).toEqual(
        outsiders.has(relationship) ? ["gmail"] : ["gmail", "slack"],
      );
    }
  });

  it("keeps a client off Slack however they were characterised", () => {
    const { spec } = assemble({
      cast: [
        AUTHORED_CAST[0]!,
        person({
          name: "Clive Mercer",
          relationship: "client",
          brief: "Posts in #ops when he is ignored and tags whoever is online.",
        }),
        person({ name: "Moira Kelb", relationship: "vendor", brief: "Chases in Slack." }),
        person({ name: "Bea Voss", relationship: "peer" }),
      ],
    });
    // `surfaces` is a containment rule and not a characterisation. It stays
    // derived precisely so a brief cannot argue its way onto a surface — an
    // outsider in #ops has read the channel the answer is hidden in.
    expect(persona(spec.director.personas, "clive-mercer").surfaces).toEqual(["gmail"]);
    expect(persona(spec.director.personas, "moira-kelb").surfaces).toEqual(["gmail"]);
    expect(persona(spec.director.personas, "bea-voss").surfaces).toEqual(["gmail", "slack"]);
  });

  it("never gives the mailbox owner a persona", () => {
    const { spec, seed } = assemble();
    // The agent already writes from that mailbox; a director that could answer
    // as the owner would be answering itself.
    expect(spec.director.personas.map((p) => p.personId)).not.toContain(seed.mailboxOwner);
  });
});

describe("the five days that ship", () => {
  it("assembles exactly as they did before any of this existed", () => {
    // The regression bar. A template authors no brief, no off-limits and no
    // style, so every one of them must come out of the assembler with the two
    // standing prohibitions, the default register and the old derived numbers —
    // a day nobody characterised must not change because characterising became
    // possible.
    for (const template of TEMPLATES) {
      const { spec, seed } = assembleTemplate(template);
      expect(spec.director.offLimits, template.id).toEqual([
        "Never tell the agent what to do next, or name the action it should take.",
        "Never volunteer a fact it has not asked for.",
      ]);
      expect(spec.director.style, template.id).toBe(
        "Short, busy, specific. Write like someone with six other things open.",
      );
      for (const p of spec.director.personas) {
        const who = seed.cast.find((c) => c.id === p.personId)!;
        const label = `${template.id}/${p.personId}`;
        expect(p.brief, label).toBeUndefined();
        expect(p.responsiveness, label).toBe(who.relationship === "client" ? 0.7 : 0.85);
        expect(p.replyDelayTicks, label).toBe(who.relationship === "client" ? 2 : 1);
      }
    }
  });

  it("has nobody outside the company standing in a channel", () => {
    // The one deliberate difference from "before any of this existed", and it is
    // a fix rather than a feature: candidate-scheduling's Amara is an
    // interviewee holding a competing offer, and she used to carry a Slack
    // persona, so the director could put her in #hiring — the channel the
    // interview loop, the debrief and the other candidate are discussed in.
    // Nothing scores a persona's surfaces, so this changes no verdict; it closes
    // a way for the world to hand the agent, or the outsider, the wrong page.
    for (const template of TEMPLATES) {
      const { spec, seed } = assembleTemplate(template);
      for (const p of spec.director.personas) {
        const who = seed.cast.find((c) => c.id === p.personId)!;
        if (["client", "vendor", "candidate"].includes(who.relationship)) {
          expect(p.surfaces, `${template.id}/${p.personId}`).toEqual(["gmail"]);
        }
      }
    }
  });
});

describe("the generation schema", () => {
  it("requires the character fields rather than offering them", () => {
    // The convention this file exists to protect: every field required, unused
    // ones sent as "". `ref`, `expect` and `target` were optional once and the
    // model simply left them out — a `brief` marked optional would come back
    // absent for exactly the same reason, and the cast would go back to being a
    // list of names with nothing to say it had.
    const cast = (SCENARIO_SCHEMA.properties as Record<string, { items: { required: string[] } }>).cast;
    for (const field of ["name", "role", "relationship", "voice", "brief", "responsiveness", "replyDelayTicks"]) {
      expect(cast.items.required, field).toContain(field);
    }
    expect(SCENARIO_SCHEMA.required).toContain("offLimits");
    expect(SCENARIO_SCHEMA.required).toContain("style");
  });
});
