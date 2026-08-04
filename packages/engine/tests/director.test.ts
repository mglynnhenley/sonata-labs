import { describe, it, expect } from "vitest";
import type { DirectorPolicy, TwinAuditRow } from "@sonata/core";
import type { CompleteJSONOptions } from "../src/llm";
import {
  auditRefName,
  boundEvents,
  createDirector,
  directorPrompt,
  directorSystemPrompt,
  quietWindow,
  reactionDecision,
  type DirectorContext,
} from "../src/director";
import { auditRow, spec, world } from "./fixtures";

// The director is the only part of the engine that hands a model the pen. Every
// property that keeps a day a day is enforced in code, so every one of them is
// assertable without a network — which is the whole reason `complete` is a seam.

const RAW = {
  personId: "dana",
  surface: "gmail",
  kind: "email",
  reason: "she has been waiting since Tuesday",
  subject: "Re: freight",
  to: [] as string[],
  body: "Any update?",
  channel: "",
  emoji: "",
  replyToRef: "",
  eventRef: "",
  response: "",
};

const policy = (over: Partial<DirectorPolicy> = {}): DirectorPolicy => ({
  ...spec().director,
  ...over,
});

const ctx = (over: Partial<DirectorContext> = {}): DirectorContext => ({
  tick: 1,
  simTimeISO: "2026-08-04T09:15:00.000Z",
  simTimeLabel: "09:15",
  history: [],
  deltas: [],
  beatsThisTick: [],
  upcoming: [],
  ...over,
});

/** A model seam that answers with a fixed plan and counts how often it is asked. */
function stub(events: unknown[]) {
  const asked: CompleteJSONOptions[] = [];
  const complete = async <T>(opts: CompleteJSONOptions): Promise<T> => {
    asked.push(opts);
    return { events } as T;
  };
  return { complete, asked };
}

describe("boundEvents", () => {
  const idFor = (i: number) => `e${i}`;

  it("never exceeds maxEventsPerTick, however much the model returns", () => {
    const raw = [
      { ...RAW, personId: "dana" },
      { ...RAW, personId: "sam", surface: "slack", kind: "message", channel: "ops" },
      { ...RAW, personId: "priya" },
    ];
    for (const cap of [0, 1, 2, 5]) {
      const out = boundEvents(raw, policy({ maxEventsPerTick: cap, personas: [
        { personId: "dana", responsiveness: 1, replyDelayTicks: 0, surfaces: ["gmail"] },
        { personId: "sam", responsiveness: 1, replyDelayTicks: 0, surfaces: ["slack"] },
        { personId: "priya", responsiveness: 1, replyDelayTicks: 0, surfaces: ["gmail"] },
      ] }), world, idFor);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });

  it("treats a nonsense cap as zero rather than as infinity", () => {
    const raw = [{ ...RAW }];
    expect(boundEvents(raw, policy({ maxEventsPerTick: Number.NaN }), world, idFor)).toEqual([]);
    expect(boundEvents(raw, policy({ maxEventsPerTick: -3 }), world, idFor)).toEqual([]);
    expect(boundEvents(raw, policy({ maxEventsPerTick: 1.9 }), world, idFor)).toHaveLength(1);
  });

  it("lets each person move once per tick", () => {
    const out = boundEvents(
      [{ ...RAW }, { ...RAW, subject: "and again" }],
      policy({ maxEventsPerTick: 5 }),
      world,
      idFor,
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e0");
  });

  it("drops anyone outside the policy's cast", () => {
    const out = boundEvents(
      [
        { ...RAW, personId: "nobody@elsewhere.test" },
        // In the world's cast, but with no persona in this policy.
        { ...RAW, personId: "priya" },
        { ...RAW, personId: "dana" },
      ],
      policy({ maxEventsPerTick: 5 }),
      world,
      idFor,
    );
    expect(out.map((e) => e.personId)).toEqual(["dana"]);
  });

  it("keeps a persona off surfaces their policy does not list", () => {
    const slackFromAClient = {
      ...RAW,
      personId: "dana",
      surface: "slack",
      kind: "message",
      channel: "ops",
    };
    // Dana answers on gmail only, so a client never turns up in a channel.
    expect(boundEvents([slackFromAClient], policy({ maxEventsPerTick: 5 }), world, idFor)).toEqual([]);
  });

  it("drops a kind the surface cannot carry", () => {
    const mixed = [
      { ...RAW, personId: "dana", surface: "gmail", kind: "message" },
      { ...RAW, personId: "sam", surface: "slack", kind: "email" },
      { ...RAW, personId: "sam", surface: "slack", kind: "invite" },
    ];
    expect(boundEvents(mixed, policy({ maxEventsPerTick: 5 }), world, idFor)).toEqual([]);
  });

  it("drops an event with nothing in it", () => {
    const empty = [
      { ...RAW, body: "  " },
      { ...RAW, personId: "sam", surface: "slack", kind: "message", channel: "" },
      { ...RAW, personId: "sam", surface: "slack", kind: "reaction", emoji: "", replyToRef: "x" },
    ];
    expect(boundEvents(empty, policy({ maxEventsPerTick: 5 }), world, idFor)).toEqual([]);
  });

  it("addresses an unaddressed reply to the mailbox owner", () => {
    const [event] = boundEvents([{ ...RAW, to: [] }], policy(), world, idFor);
    expect(event.twin).toBe("gmail");
    if (event.twin !== "gmail") throw new Error("expected a gmail event");
    expect(event.payload.to).toEqual(["priya"]);
    expect(event.payload.from).toBe("dana");
    expect(event.payload.subject).toBe("Re: freight");
  });

  it("normalises what the model wrote loosely", () => {
    const [msg] = boundEvents(
      [
        {
          ...RAW,
          personId: "U03SAM",
          surface: "slack",
          kind: "message",
          channel: "#ops",
          replyToRef: "act:slack:7",
        },
      ],
      policy({ maxEventsPerTick: 1 }),
      world,
      idFor,
    );
    // Resolved to the cast id, and the channel's leading hash stripped.
    expect(msg.personId).toBe("sam");
    if (msg.twin !== "slack" || msg.kind !== "message") throw new Error("expected a slack message");
    expect(msg.payload.channel).toBe("ops");
    expect(msg.payload.threadRef).toBe("act:slack:7");
  });

  it("only accepts the three real RSVP answers", () => {
    const calendarPolicy = policy({
      maxEventsPerTick: 3,
      personas: [{ personId: "dana", responsiveness: 1, replyDelayTicks: 0, surfaces: ["calendar"] }],
    });
    const ok = boundEvents(
      [{ ...RAW, surface: "calendar", kind: "rsvp", eventRef: "review", response: "declined" }],
      calendarPolicy,
      world,
      idFor,
    );
    expect(ok).toHaveLength(1);
    const bad = boundEvents(
      [{ ...RAW, surface: "calendar", kind: "rsvp", eventRef: "review", response: "maybe" }],
      calendarPolicy,
      world,
      idFor,
    );
    expect(bad).toEqual([]);
  });
});

describe("reactionDecision", () => {
  it("stays silent when the policy has switched the world off", () => {
    const d = reactionDecision(policy({ maxEventsPerTick: 0 }), ctx({ deltas: [auditRow({ id: 1, twin: "gmail" })] }), 0);
    expect(d.react).toBe(false);
    expect(d.note).toMatch(/disabled by policy/);
  });

  it("speaks when the agent has acted or a beat has landed", () => {
    const deltas: TwinAuditRow[] = [auditRow({ id: 1, twin: "slack" })];
    expect(reactionDecision(policy(), ctx({ deltas }), -1).react).toBe(true);
  });

  it("stays silent before anything at all has happened", () => {
    const d = reactionDecision(policy(), ctx(), -1);
    expect(d.react).toBe(false);
    expect(d.note).toMatch(/nothing has happened yet/);
  });

  it("keeps answering inside the longest reply delay, then goes quiet", () => {
    // Dana's delay is 1 tick, so tick 5 may still answer tick 4 — tick 6 may not.
    expect(quietWindow(policy())).toBe(1);
    expect(reactionDecision(policy(), ctx({ tick: 5 }), 4).react).toBe(true);
    expect(reactionDecision(policy(), ctx({ tick: 6 }), 4).react).toBe(false);
  });
});

describe("createDirector", () => {
  it("produces nothing, and calls no model, when the agent did nothing", async () => {
    const { complete, asked } = stub([{ ...RAW }]);
    const director = createDirector({ spec: spec(), complete });
    expect(await director.react(ctx({ tick: 0 }))).toEqual([]);
    expect(asked).toHaveLength(0);
    expect(director.lastNote()).toMatch(/nothing has happened yet/);
  });

  it("caps what a chatty model returns at the policy's number", async () => {
    const chatty = Array.from({ length: 9 }, (_, i) => ({
      ...RAW,
      personId: i % 2 === 0 ? "dana" : "sam",
      surface: i % 2 === 0 ? "gmail" : "slack",
      kind: i % 2 === 0 ? "email" : "message",
      channel: "ops",
    }));
    const { complete, asked } = stub(chatty);
    const director = createDirector({ spec: spec(), complete });
    const events = await director.react(ctx({ deltas: [auditRow({ id: 4, twin: "gmail" })] }));

    // Two events, one each, from one call — never nine, and never two calls.
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.personId)).size).toBe(2);
    expect(asked).toHaveLength(1);
    expect(events.map((e) => e.id)).toEqual(["dir-1-0", "dir-1-1"]);
  });

  it("renders offLimits into the prompt verbatim, and omits the heading when there is none", () => {
    const prompt = directorSystemPrompt(spec());
    expect(prompt).toContain("OFF LIMITS");
    expect(prompt).toContain("- the refund policy");

    const open = directorSystemPrompt(spec({ director: policy({ offLimits: [] }) }));
    expect(open).not.toContain("OFF LIMITS");
  });

  it("shows the model the story, the agent's moves and what is still to come", () => {
    const prompt = directorPrompt(
      ctx({
        deltas: [auditRow({ id: 9, twin: "slack", summary: "Posted in #ops" })],
        upcoming: ["11:00 — the escalation lands"],
      }),
      auditRefName,
    );
    expect(prompt).toContain("IT IS 09:15 (tick 1)");
    expect(prompt).toContain("Posted in #ops");
    expect(prompt).toContain('replyToRef "act:slack:9"');
    expect(prompt).toContain("11:00 — the escalation lands");
  });

  it("survives a model that fails, and says why the world went quiet", async () => {
    const director = createDirector({
      spec: spec(),
      complete: () => Promise.reject(new Error("provider timed out")),
    });
    const events = await director.react(ctx({ beatsThisTick: [
      { beatId: "b1", twin: "gmail", kind: "email", summary: "Dana emailed" },
    ] }));
    expect(events).toEqual([]);
    expect(director.lastNote()).toBe("director call failed: provider timed out");
  });

  it("survives a model that answers with the wrong shape", async () => {
    const { complete } = stub([]);
    const director = createDirector({ spec: spec(), complete: complete as never });
    const events = await director.react(ctx({ deltas: [auditRow({ id: 1, twin: "gmail" })] }));
    expect(events).toEqual([]);
    expect(director.lastNote()).toBe("director had the world stay quiet");
  });
});

describe("auditRefName", () => {
  it("offers a ref only for rows that point at something", () => {
    expect(auditRefName(auditRow({ id: 7, twin: "gmail" }))).toBe("act:gmail:7");
    expect(auditRefName(auditRow({ id: 7, twin: "gmail", targetId: null }))).toBe("");
  });
});
