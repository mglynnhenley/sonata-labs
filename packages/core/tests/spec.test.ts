import { describe, expect, it } from "vitest";
import { displayAddress, emailOf, owner, resolvePerson, slackIdOf } from "../src/cast";
import { beatsAt, danglingRefs, episodeTwins, plannedTicks } from "../src/spec";
import type { Beat, EpisodeSpec } from "../src/types/episode";
import type { Person, WorldSeed } from "../src/types/world";

// The shared cast and the spec reads are what keep one person the same person in
// three twins, and what catches a scenario that points at a beat nobody wrote.

function person(id: string, over: Partial<Person> = {}): Person {
  return {
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} Reyes`,
    email: `${id}@acme.test`,
    slackUserId: `U${id.toUpperCase()}`,
    role: "Ops",
    relationship: "peer",
    voice: "clipped, lowercase",
    ...over,
  };
}

const world: WorldSeed = {
  business: { name: "Acme", description: "fintech", industry: "finance", size: 12 },
  cast: [person("mia"), person("dana")],
  channels: [
    { id: "C1", name: "ops", purpose: "day to day", members: ["mia", "dana"], isPrivate: false },
  ],
  mailboxOwner: "mia",
};

const beats: Beat[] = [
  {
    id: "b1",
    tick: 2,
    ref: "escalation",
    twin: "gmail",
    kind: "email",
    payload: { from: "dana", to: ["mia"], subject: "SLA missed", body: "we need an answer" },
  },
  {
    id: "b2",
    tick: 2,
    twin: "slack",
    kind: "message",
    payload: { channel: "ops", from: "dana", text: "did anyone see that email" },
  },
  {
    id: "b3",
    tick: 6,
    twin: "gmail",
    kind: "email",
    payload: {
      from: "dana",
      to: ["mia"],
      subject: "Re: SLA missed",
      body: "any update?",
      inReplyTo: "escalation",
    },
  },
];

function spec(over: Partial<EpisodeSpec> = {}): EpisodeSpec {
  return {
    id: "e1",
    title: "Client escalates",
    story: "A client escalates while the owner is double-booked.",
    task: "Run ops for the day.",
    world,
    clock: { startISO: "2026-08-04T09:00:00Z", ticks: 32, simMinutesPerTick: 15 },
    beats,
    director: { maxEventsPerTick: 2, personas: [], offLimits: [], style: "brief" },
    success: {
      checklist: [
        {
          id: "k1",
          description: "the client got an answer",
          twin: "gmail",
          kind: "replied",
          ref: "escalation",
          weight: 2,
          severity: "must",
        },
      ],
      judgeQuestions: ["Did it keep the client informed?"],
    },
    termination: { stopWhenAllMustPass: false, idleTicks: 6, maxWallClockMs: 600_000 },
    ...over,
  };
}

describe("beatsAt", () => {
  it("returns every beat on a tick, in author order", () => {
    expect(beatsAt(beats, 2).map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(beatsAt(beats, 3)).toEqual([]);
  });
});

describe("episodeTwins", () => {
  it("derives the surfaces from beats and criteria, in canonical order", () => {
    expect(episodeTwins(spec())).toEqual(["gmail", "slack"]);
  });

  it("counts a twin named only by a criterion", () => {
    const s = spec();
    s.success.checklist.push({
      id: "k2",
      description: "the 2pm moved",
      twin: "calendar",
      kind: "moved",
      weight: 1,
      severity: "should",
    });
    expect(episodeTwins(s)).toEqual(["gmail", "slack", "calendar"]);
  });

  it("does not count an `any` criterion as a surface of its own", () => {
    const s = spec({ beats: [beats[0]] });
    s.success.checklist = [
      {
        id: "k3",
        description: "said the same thing everywhere",
        twin: "any",
        kind: "judged",
        weight: 1,
        severity: "should",
      },
    ];
    expect(episodeTwins(s)).toEqual(["gmail"]);
  });
});

describe("plannedTicks", () => {
  it("is the day when no cap is set", () => {
    expect(plannedTicks(spec())).toBe(32);
  });

  it("lets maxTicks shorten the day but never extend it", () => {
    const short = spec();
    short.termination.maxTicks = 8;
    expect(plannedTicks(short)).toBe(8);

    const greedy = spec();
    greedy.termination.maxTicks = 999;
    expect(plannedTicks(greedy)).toBe(32);
  });
});

describe("danglingRefs", () => {
  it("finds nothing in a well-formed spec", () => {
    expect(danglingRefs(spec())).toEqual([]);
  });

  it("names a ref that no beat creates, once", () => {
    const s = spec();
    s.beats = [
      ...beats,
      {
        id: "b4",
        tick: 9,
        twin: "calendar",
        kind: "cancel",
        payload: { eventRef: "review-meeting" },
      },
      {
        id: "b5",
        tick: 10,
        twin: "slack",
        kind: "reaction",
        payload: { messageRef: "review-meeting", from: "dana", emoji: "eyes" },
      },
    ];
    expect(danglingRefs(s)).toEqual(["review-meeting"]);
  });

  it("catches a criterion pointing at a beat nobody wrote", () => {
    const s = spec();
    s.success.checklist[0].ref = "the-one-that-got-away";
    expect(danglingRefs(s)).toEqual(["the-one-that-got-away"]);
  });
});

describe("the shared cast", () => {
  it("resolves the same person by id, email or Slack id", () => {
    const byId = resolvePerson(world, "dana");
    expect(resolvePerson(world, "dana@acme.test")).toBe(byId);
    expect(resolvePerson(world, "UDANA")).toBe(byId);
  });

  it("returns undefined for someone outside the cast rather than inventing one", () => {
    expect(resolvePerson(world, "stranger@elsewhere.test")).toBeUndefined();
    expect(emailOf(world, "stranger@elsewhere.test")).toBe("stranger@elsewhere.test");
    expect(slackIdOf(world, "stranger@elsewhere.test")).toBe("stranger@elsewhere.test");
    expect(displayAddress(world, "stranger@elsewhere.test")).toBe("stranger@elsewhere.test");
  });

  it("projects one ref into each twin's own identity", () => {
    expect(emailOf(world, "dana")).toBe("dana@acme.test");
    expect(slackIdOf(world, "dana")).toBe("UDANA");
    expect(displayAddress(world, "dana")).toBe("Dana Reyes <dana@acme.test>");
  });

  it("throws when the seed names an owner who is not in the cast", () => {
    expect(owner(world).id).toBe("mia");
    expect(() => owner({ ...world, mailboxOwner: "ghost" })).toThrow(/mailboxOwner/);
  });
});
