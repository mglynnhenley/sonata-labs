import { describe, it, expect } from "vitest";
import type { Beat } from "@sonata/core";
import {
  createRefRegistry,
  fireBeats,
  injectBody,
  scheduleBeats,
  summarizeBody,
  unreachableBeats,
} from "../src/beats";
import { beat, fakeAdapter, world } from "./fixtures";

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
