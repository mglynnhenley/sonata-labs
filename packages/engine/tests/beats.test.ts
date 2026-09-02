import { describe, it, expect } from "vitest";
import type { Beat, BeatAdaptation, TickRecord, TwinSnapshot } from "@sonata/core";
import {
  adaptBeats,
  beatWords,
  createRefRegistry,
  fireBeats,
  injectBody,
  missingFacts,
  scheduleBeats,
  summarizeBody,
  unreachableBeats,
  withBeatWords,
  type AdaptDeps,
} from "../src/beats";
import type { BeatRewrite, RewriteOutcome } from "../src/director";
import { auditRow, beat, fakeAdapter, spec, world } from "./fixtures";

const at = "2026-08-04T09:15:00.000Z";

function deps() {
  const gmail = fakeAdapter("gmail");
  const slack = fakeAdapter("slack");
  return {
    gmail,
    slack,
    inject: { adapters: { gmail, slack }, world, refs: createRefRegistry() },
  };
}

describe("scheduleBeats", () => {
  it("fires every beat exactly on its own tick, none early and none dropped", () => {
    const beats: Beat[] = [
      beat({ id: "a", tick: 0 }),
      beat({ id: "b", tick: 2 }),
      beat({ id: "c", tick: 2 }),
      beat({ id: "d", tick: 5 }),
    ];
    const schedule = scheduleBeats(beats);

    const fired: string[] = [];
    for (let tick = 0; tick < 6; tick++) fired.push(...schedule.at(tick).map((b) => b.id));

    expect(fired).toEqual(["a", "b", "c", "d"]);
    expect(schedule.count).toBe(4);
    expect(schedule.ticks()).toEqual([0, 2, 5]);
    // Ticks between scheduled ones are genuinely empty, not "everything so far".
    expect(schedule.at(1)).toEqual([]);
    expect(schedule.at(3)).toEqual([]);
  });

  it("keeps author order inside a tick, because threading depends on it", () => {
    const schedule = scheduleBeats([
      beat({ id: "reply", tick: 1 }),
      beat({ id: "opener", tick: 1 }),
    ]);
    // Not sorted by id, not stable-sorted into some canonical order: the spec's
    // array order is the only record of "this one has to land first".
    expect(schedule.at(1).map((b) => b.id)).toEqual(["reply", "opener"]);
  });

  it("names beats scheduled outside the day", () => {
    const beats = [
      beat({ id: "ok", tick: 3 }),
      beat({ id: "late", tick: 4 }),
      beat({ id: "early", tick: -1 }),
      beat({ id: "fractional", tick: 1.5 }),
    ];
    expect(unreachableBeats(beats, 4).map((b) => b.id)).toEqual(["late", "early", "fractional"]);
    expect(unreachableBeats(beats, 99).map((b) => b.id)).toEqual(["early", "fractional"]);
  });
});

describe("the ref registry", () => {
  it("binds a ref once, so a criterion cannot be quietly redirected", () => {
    const refs = createRefRegistry();
    refs.record("escalation", { twin: "gmail", id: "m1" });
    refs.record("escalation", { twin: "gmail", id: "m2" });
    expect(refs.resolve("escalation")?.id).toBe("m1");
    expect(refs.entries()).toEqual({ escalation: { twin: "gmail", id: "m1" } });
  });

  it("ignores an unnamed beat", () => {
    const refs = createRefRegistry();
    refs.record(undefined, { twin: "gmail", id: "m1" });
    expect(refs.entries()).toEqual({});
  });
});

describe("injectBody", () => {
  it("routes a body to its own twin and hands back the twin's handle", async () => {
    const d = deps();
    const outcome = await injectBody(beat({ id: "a", tick: 0 }), at, d.inject);
    expect(outcome.handle).toEqual({ twin: "gmail", id: "gmail-1", containerId: "gmail-c" });
    expect(d.gmail.injected).toEqual([{ kind: "email", atISO: at }]);
    expect(d.slack.injected).toEqual([]);
  });

  it("records a failure instead of throwing, so one bad beat cannot end a day", async () => {
    const d = deps();
    d.gmail.failInject = "twin returned 500";
    const outcome = await injectBody(beat({ id: "a", tick: 0 }), at, d.inject);
    expect(outcome.handle).toBeUndefined();
    expect(outcome.error).toBe("twin returned 500");
  });

  it("says so when the run has no adapter for that twin", async () => {
    const outcome = await injectBody(beat({ id: "a", tick: 0 }), at, {
      adapters: {},
      world,
      refs: createRefRegistry(),
    });
    expect(outcome.error).toBe("no gmail adapter in this run");
  });
});

describe("fireBeats", () => {
  it("fires in order, dates everything with simulated time, and records refs", async () => {
    const d = deps();
    const fired = await fireBeats(
      [
        beat({ id: "a", tick: 1, ref: "opener" }),
        beat({
          id: "b",
          tick: 1,
          twin: "slack",
          kind: "message",
          payload: { channel: "ops", from: "sam", text: "on it" },
        }),
      ],
      at,
      d.inject,
    );

    expect(fired.map((f) => f.beatId)).toEqual(["a", "b"]);
    expect(fired[0].ref).toBe("opener");
    expect(fired[0].handle?.id).toBe("gmail-1");
    expect(d.inject.refs.resolve("opener")?.id).toBe("gmail-1");
    // Simulated time, never the wall clock.
    expect(d.gmail.injected[0].atISO).toBe(at);
    expect(d.slack.injected[0].atISO).toBe(at);
  });

  it("keeps going after a failed beat and carries the reason onto the record", async () => {
    const d = deps();
    d.slack.failInject = "channel not found";
    const fired = await fireBeats(
      [
        beat({
          id: "bad",
          tick: 0,
          twin: "slack",
          kind: "message",
          payload: { channel: "nope", from: "sam", text: "?" },
        }),
        beat({ id: "good", tick: 0, ref: "later" }),
      ],
      at,
      d.inject,
    );

    expect(fired[0].error).toBe("channel not found");
    expect(fired[0].handle).toBeUndefined();
    expect(fired[1].error).toBeUndefined();
    // A beat that did not land binds no ref: a criterion pointing at it must not
    // resolve to something else that happened to fire.
    expect(d.inject.refs.entries()).toEqual({
      later: { twin: "gmail", id: "gmail-1", containerId: "gmail-c" },
    });
  });
});

// ---------------------------------------------------------------------------
// Adaptive wording.
//
// The one property under all of these: the beat still fires, on its own tick,
// with its own ref. Only the sentence moves — and only when the judge's own
// checkers say, in code, that the agent already acted.
// ---------------------------------------------------------------------------

const AUTHORED = "I've had nothing since nine o'clock. I need a plan and a time, and the £40k credit stands.";

/** The escalation: the same shape as `ce-b10`, adaptive, with a fact to protect. */
function escalation(over: Partial<BeatAdaptation> = {}): Beat {
  return beat({
    id: "esc",
    tick: 2,
    ref: "escalation",
    payload: { from: "dana", to: ["priya"], subject: "Where is my freight", body: AUTHORED },
    adapt: {
      when: {
        description: "the assistant already answered the opening email",
        twin: "gmail",
        kind: "replied",
        ref: "opener",
      },
      facts: ["£40k credit"],
      ...over,
    },
  });
}

const emptyGmail: TwinSnapshot = { twin: "gmail", capturedAt: 0, labels: [], threads: [], drafts: [] };

/** A tick in which the opening beat landed, so `refsFromTicks` can resolve it. */
function openerFired(): TickRecord {
  return {
    tick: 0,
    simTimeISO: "2026-08-04T09:00:00.000Z",
    startedAt: 0,
    endedAt: 100,
    beatsFired: [
      {
        beatId: "opener",
        ref: "opener",
        twin: "gmail",
        kind: "email",
        handle: { twin: "gmail", id: "gmail-1", containerId: "gmail-c" },
        summary: "Dana emailed Priya",
      },
    ],
    directorEvents: [],
    agentSteps: [],
    notes: [],
  };
}

/** A rewriter that records what it was asked and answers with `words`. */
function rewriter(words: string | { error: string }) {
  const asked: BeatRewrite[] = [];
  const rewrite = (req: BeatRewrite): Promise<RewriteOutcome> => {
    asked.push(req);
    return Promise.resolve(typeof words === "string" ? { words } : words);
  };
  return { rewrite, asked };
}

function adaptDeps(over: Partial<AdaptDeps> = {}): AdaptDeps {
  const gmail = fakeAdapter("gmail");
  return {
    spec: spec(),
    director: rewriter("Second time of asking — the £40k credit still needs a date."),
    adapters: { gmail },
    before: { gmail: emptyGmail },
    audit: [],
    ticks: [openerFired()],
    tick: 2,
    simTimeLabel: "09:30",
    ...over,
  };
}

/** The agent's reply, as the twin logged it: a send that touches the thread. */
const repliedRow = auditRow({
  id: 7,
  twin: "gmail",
  ts: 50,
  actionType: "send",
  targetId: "gmail-c",
  summary: 'Sent "Re: Where is my freight" to dana@acme.test',
});

describe("beatWords", () => {
  it("finds the wording of the two kinds that have one, and refuses the rest", () => {
    expect(beatWords(escalation())).toBe(AUTHORED);
    expect(
      beatWords({ twin: "slack", kind: "message", payload: { channel: "ops", from: "sam", text: "hi" } }),
    ).toBe("hi");
    // A reaction is an emoji and an invitation is a time and a guest list. Letting
    // a model reword either would be letting it reword the day's facts.
    expect(
      beatWords({ twin: "slack", kind: "reaction", payload: { messageRef: "x", from: "sam", emoji: "eyes" } }),
    ).toBeNull();
    expect(
      beatWords({ twin: "calendar", kind: "cancel", payload: { eventRef: "x", reason: "clash" } }),
    ).toBeNull();
  });

  it("replaces the wording and nothing else", () => {
    const next = withBeatWords(escalation(), "different words");
    expect(beatWords(next)).toBe("different words");
    // Everything a criterion binds through is untouched.
    expect(next.id).toBe("esc");
    expect(next.ref).toBe("escalation");
    expect(next.tick).toBe(2);
    expect(next.twin).toBe("gmail");
    expect(next.kind === "email" && next.payload.subject).toBe("Where is my freight");
    expect(next.kind === "email" && next.payload.to).toEqual(["priya"]);
  });
});

describe("missingFacts", () => {
  it("survives a line break and a change of case, and names what was lost", () => {
    expect(missingFacts("the £40K\nCREDIT stands", ["£40k credit"])).toEqual([]);
    expect(missingFacts("nothing of the sort", ["£40k credit", "Friday"])).toEqual([
      "£40k credit",
      "Friday",
    ]);
    // An empty list is a real statement: nothing here is load-bearing.
    expect(missingFacts("anything at all", [])).toEqual([]);
  });
});

describe("adaptBeats", () => {
  it("leaves a tick with no adaptive beat alone, and reads nothing to do it", async () => {
    // The regression bar: a scenario with nothing marked adaptive costs no
    // snapshot, no model call, and produces the same array it was handed.
    const gmail = fakeAdapter("gmail");
    let snapshots = 0;
    gmail.snapshot = () => {
      snapshots += 1;
      return Promise.resolve(emptyGmail);
    };
    const model = rewriter("never asked");
    const plain = [beat({ id: "a", tick: 2 }), beat({ id: "b", tick: 2 })];
    const out = await adaptBeats(plain, adaptDeps({ adapters: { gmail }, director: model }));

    expect(out.beats).toBe(plain);
    expect(out.notes).toEqual([]);
    expect(snapshots).toBe(0);
    expect(model.asked).toHaveLength(0);
  });

  it("rewords the beat when the checker says the agent replied, keeping tick and ref", async () => {
    const model = rewriter("Second time of asking — the £40k credit still needs a date.");
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], director: model }),
    );

    expect(out.beats[0].tick).toBe(2);
    expect(out.beats[0].ref).toBe("escalation");
    expect(beatWords(out.beats[0])).toBe("Second time of asking — the £40k credit still needs a date.");
    // The person the beat was always from, and the words they were going to send.
    expect(model.asked[0].personId).toBe("dana");
    expect(model.asked[0].authored).toBe(AUTHORED);
    expect(model.asked[0].facts).toEqual(["£40k credit"]);
    expect(model.asked[0].saw).toContain("gmail-c");
  });

  it("carries what the sender made of the agent onto the beat that fired", async () => {
    // The wiring this asserts is the whole point of the feature for the judge:
    // the person rewording a beat has already worked out whether the reply
    // satisfied them, and without this it was computed and thrown away.
    const view = { personId: "dana", satisfied: "partly" as const, missing: "a date" };
    const rewrite = () => Promise.resolve({ words: "Still need a date on the £40k credit.", assessment: view });
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], director: { rewrite } }),
    );
    expect(out.assessments.get("esc")).toEqual(view);

    const fired = await fireBeats(out.beats, "2026-01-01T09:30:00.000Z", deps().inject, out.assessments);
    expect(fired[0].assessment).toEqual(view);
  });

  it("keeps the sender's view even when their words were thrown away", async () => {
    // A rewrite that lost a required fact is discarded and the beat fires as
    // authored — but what Dana made of the reply is true either way, and it is
    // the only evidence the day has for why the world behaved as it did.
    const view = { personId: "dana", satisfied: "no" as const };
    const rewrite = () => Promise.resolve({ words: "no numbers here at all", assessment: view });
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], director: { rewrite } }),
    );
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("dropped");
    expect(out.assessments.get("esc")).toEqual(view);
  });

  it("stamps nothing on a beat nobody was asked about", async () => {
    const plain = [beat({ id: "a", tick: 2 })];
    const out = await adaptBeats(plain, adaptDeps({}));
    const fired = await fireBeats(out.beats, "2026-01-01T09:30:00.000Z", deps().inject, out.assessments);
    expect("assessment" in fired[0]).toBe(false);
  });

  it("fires the authored text when the agent has not acted", async () => {
    // No audit row, so the same checker that grades the day answers "no reply
    // landed" — and the beat reads exactly as it does today.
    const model = rewriter("should never be used");
    const out = await adaptBeats([escalation()], adaptDeps({ director: model }));

    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(model.asked).toHaveLength(0);
    expect(out.notes[0]).toContain("the agent has not");
    expect(out.notes[0]).toContain("no reply landed");
  });

  it("fires the authored text when the condition cannot be decided", async () => {
    const model = rewriter("should never be used");
    const out = await adaptBeats(
      [escalation({ when: { description: "answered the beat that never fired", twin: "gmail", kind: "replied", ref: "no-such-beat" } })],
      adaptDeps({ audit: [repliedRow], director: model }),
    );

    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(model.asked).toHaveLength(0);
    expect(out.notes[0]).toContain("undecidable");
  });

  it("fires the authored text when the rewrite drops a required fact", async () => {
    // The beat may be the only place the day ever says the number every criterion
    // downstream assumes the agent was told. A wording that lost it is discarded
    // whole, not patched.
    const model = rewriter("Second time of asking. I need a date.");
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], director: model }),
    );

    expect(model.asked).toHaveLength(1);
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain('dropped "£40k credit"');
  });

  it("fires the authored text when the rewrite call fails", async () => {
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], director: rewriter({ error: "provider timed out" }) }),
    );
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("provider timed out");
  });

  it("fires the authored text when the run has no rewriter at all", async () => {
    // Every hand-rolled `Director` predating this — the beat still fires, on time.
    const out = await adaptBeats([escalation()], adaptDeps({ audit: [repliedRow], director: {} }));
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("No rewriter in this run");
  });

  it("fires the authored text when the surface could not be captured", async () => {
    const gmail = fakeAdapter("gmail");
    gmail.snapshot = () => Promise.reject(new Error("twin is down"));
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({ audit: [repliedRow], adapters: { gmail } }),
    );
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("no gmail snapshot");
  });

  it("records what was asked, what it saw and what it concluded, every time", async () => {
    // Two runs of one spec have to diff line for line, and a rewrite has to be
    // explainable months later off the artifact alone.
    const acted = await adaptBeats([escalation()], adaptDeps({ audit: [repliedRow] }));
    expect(acted.notes).toHaveLength(1);
    expect(acted.notes[0]).toContain("beat esc adapt: asked gmail/replied");
    expect(acted.notes[0]).toContain('on "opener"');
    expect(acted.notes[0]).toContain("the assistant already answered the opening email");
    expect(acted.notes[0]).toContain("Reworded in character as Dana Reyes");

    const not = await adaptBeats([escalation()], adaptDeps({}));
    expect(not.notes[0]).toContain("beat esc adapt: asked gmail/replied");
    expect(not.notes[0]).toContain("Fired as authored.");
  });

  it("keeps the words it sent, because nothing else in the artifact does", async () => {
    // `BeatFired.summary` for an email is sender, recipients and subject — no body
    // — so without this the record says "Dana escalated about something else" and
    // never says what, and two runs whose escalations read completely differently
    // diff identically. The twin database that does hold it is overwritten by the
    // next run's reset.
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({
        audit: [repliedRow],
        director: rewriter("Thanks — but the £40k credit\nstill needs a date."),
      }),
    );
    expect(out.notes[0]).toContain("It said: “Thanks — but the £40k credit still needs a date.”");
  });

  it("fires the authored text when adapting the beat throws outright", async () => {
    // `Director` is an interface an embedding app implements, and one that raises
    // took `runTick` with it: the run was marked failed and this beat AND every
    // beat after it never fired. A bad sentence costs one beat's wording; a throw
    // used to cost the rest of the day.
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({
        audit: [repliedRow],
        director: {
          rewrite: () => {
            throw new Error("the world's writer blew up");
          },
        },
      }),
    );
    expect(out.beats).toHaveLength(1);
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("adapting it failed outright (the world's writer blew up)");
  });

  it("fires the authored text when a rewriter resolves to nothing at all", async () => {
    // The other half of the same hazard: a hand-rolled `Director` whose `rewrite`
    // returns undefined satisfies no type check at the call site and read a field
    // of undefined inside `adaptOne`.
    const out = await adaptBeats(
      [escalation()],
      adaptDeps({
        director: { rewrite: () => Promise.resolve(undefined) } as unknown as AdaptDeps["director"],
        audit: [repliedRow],
      }),
    );
    expect(beatWords(out.beats[0])).toBe(AUTHORED);
    expect(out.notes[0]).toContain("adapting it failed outright");
  });

  it("still fires the other beats on a tick where one of them blows up", async () => {
    const boom = escalation();
    boom.id = "boom";
    const out = await adaptBeats(
      [boom, beat({ id: "quiet", tick: 2 })],
      adaptDeps({
        audit: [repliedRow],
        director: {
          rewrite: () => {
            throw new Error("nope");
          },
        },
      }),
    );
    expect(out.beats.map((b) => b.id)).toEqual(["boom", "quiet"]);
  });

  it("says so, and adapts nothing, when the kind carries no wording", async () => {
    const invite = beat({
      id: "cal",
      tick: 2,
      twin: "calendar",
      kind: "invite",
      payload: {
        title: "SLA review",
        organizer: "priya",
        attendees: ["dana"],
        startISO: "2026-08-04T14:00:00Z",
        endISO: "2026-08-04T14:30:00Z",
      },
      adapt: {
        when: { description: "already replied", twin: "gmail", kind: "replied", ref: "opener" },
        facts: [],
      },
    });
    const out = await adaptBeats([invite], adaptDeps({ audit: [repliedRow] }));
    expect(out.beats[0]).toBe(invite);
    expect(out.notes[0]).toContain("carries no wording to adapt");
  });
});

describe("summarizeBody", () => {
  it("writes one line from the world's point of view, using people's names", () => {
    expect(summarizeBody(beat({ id: "a", tick: 0 }), world)).toBe(
      'Dana Reyes emailed Priya Raman: "Where is my freight"',
    );
    expect(
      summarizeBody(
        {
          twin: "slack",
          kind: "message",
          payload: { channel: "ops", from: "sam", text: "on it" },
        },
        world,
      ),
    ).toBe('Sam Okafor posted in #ops: "on it"');
    expect(
      summarizeBody(
        {
          twin: "calendar",
          kind: "invite",
          payload: {
            title: "SLA review",
            organizer: "priya",
            attendees: ["dana"],
            startISO: "2026-08-04T14:00:00Z",
            endISO: "2026-08-04T14:30:00Z",
          },
        },
        world,
      ),
    ).toContain("Priya Raman invited Dana Reyes");
  });

  it("describes what happened on the two later surfaces, not the kind it happened as", () => {
    expect(
      summarizeBody(
        {
          twin: "attio",
          kind: "record",
          payload: { object: "deals", values: { name: "Acme renewal", stage: "Lead" } },
        },
        world,
      ),
    ).toBe('"Acme renewal" was added to the CRM as a deal');
    expect(
      summarizeBody(
        {
          twin: "attio",
          kind: "task",
          payload: { content: "Chase the PO", assignee: "priya" },
        },
        world,
      ),
    ).toBe('a follow-up landed on Priya Raman: "Chase the PO"');
    expect(
      summarizeBody(
        {
          twin: "google-docs",
          kind: "document",
          payload: { title: "SLA review", owner: "priya", paragraphs: [{ text: "Draft." }] },
        },
        world,
      ),
    ).toBe('Priya Raman shared a document: "SLA review"');
  });

  // A reaction's payload is its twin's, not the kind's: `summarizeBody` reaches
  // for the emoji only once it knows the beat is Slack's.
  it("summarizes a Slack reaction from the emoji, not the kind", () => {
    expect(
      summarizeBody(
        { twin: "slack", kind: "reaction", payload: { messageRef: "m1", from: "sam", emoji: "eyes" } },
        world,
      ),
    ).toBe("Sam Okafor reacted :eyes:");
  });

  it("falls back to the raw ref for someone outside the cast", () => {
    expect(
      summarizeBody(
        {
          twin: "gmail",
          kind: "email",
          payload: { from: "stranger@elsewhere.test", to: ["priya"], subject: "hi", body: "" },
        },
        world,
      ),
    ).toBe('stranger@elsewhere.test emailed Priya Raman: "hi"');
  });
});
