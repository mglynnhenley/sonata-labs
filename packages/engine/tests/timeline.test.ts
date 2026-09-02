import { describe, it, expect } from "vitest";
import type { BeatFired, DirectorEvent, TickRecord } from "@sonata/core";
import {
  describeEvent,
  recentHistory,
  runTimeline,
  tallyLanded,
  tickDigest,
  tickEntries,
} from "../src/timeline";

// Two readers, one source. The timeline is what a human and the judge read; the
// digest is what the agent is told, and the gap between them is deliberate.

const fired = (over: Partial<BeatFired> = {}): BeatFired => ({
  beatId: "b1",
  twin: "gmail",
  kind: "email",
  summary: 'Dana Reyes emailed Priya Raman: "Where is my freight"',
  ...over,
});

const event = (over: Partial<DirectorEvent> = {}): DirectorEvent =>
  ({
    id: "dir-1-0",
    personId: "dana",
    reason: "she has been waiting",
    twin: "gmail",
    kind: "email",
    payload: { from: "dana", to: ["priya"], subject: "Re: freight", body: "?" },
    ...over,
  }) as DirectorEvent;

const record = (over: Partial<TickRecord> = {}): TickRecord => ({
  tick: 1,
  simTimeISO: "2026-08-04T09:15:00.000Z",
  startedAt: 0,
  endedAt: 1,
  beatsFired: [],
  directorEvents: [],
  agentSteps: [],
  notes: [],
  ...over,
});

describe("tickEntries", () => {
  it("plays a tick back in the order it happened: world, then director, then agent", () => {
    const rows = tickEntries(
      record({
        beatsFired: [fired()],
        directorEvents: [event()],
        agentSteps: [
          { kind: "thought", seq: 0, at: 0, text: "reading the inbox" },
          {
            kind: "tool",
            seq: 1,
            at: 1,
            twin: "gmail",
            name: "send_reply",
            args: {},
            resultSummary: "sent reply on m1",
            isMutation: true,
          },
          { kind: "escalation", seq: 2, at: 2, text: "cannot promise a date" },
        ],
      }),
    );

    expect(rows.map((r) => r.source)).toEqual(["world", "director", "agent", "agent", "agent"]);
    expect(rows.every((r) => r.tick === 1)).toBe(true);
    expect(rows[2].text).toBe("reading the inbox");
    expect(rows[3].text).toBe("send_reply → sent reply on m1");
    expect(rows[3].seq).toBe(1);
    expect(rows[4].text).toBe("escalated to the owner: cannot promise a date");
  });

  it("says out loud when something did not land", () => {
    const rows = tickEntries(
      record({
        beatsFired: [fired({ error: "twin returned 500" })],
        directorEvents: [event({ error: "channel not found" })],
        agentSteps: [
          {
            kind: "tool",
            seq: 0,
            at: 0,
            twin: "slack",
            name: "send_message",
            args: {},
            resultSummary: "",
            isMutation: true,
            error: "channel_not_found",
          },
        ],
      }),
    );
    expect(rows[0].text).toContain("did not land: twin returned 500");
    expect(rows[1].text).toContain("did not land: channel not found");
    expect(rows[2].text).toBe("send_message failed: channel_not_found");
  });

  it("describes a director event as who did what, and why", () => {
    expect(describeEvent(event())).toBe('dana emailed: "Re: freight" — she has been waiting');
    expect(
      describeEvent(
        event({
          twin: "slack",
          kind: "message",
          payload: { channel: "#ops", from: "sam", text: "on it" },
          reason: "",
        }),
      ),
    ).toBe("dana posted in #ops");
  });

  it("describes an event on the four later surfaces without reaching for a payload it has not got", () => {
    expect(
      describeEvent(
        event({
          twin: "attio",
          kind: "note",
          payload: { parentObject: "deals", parentRecordRef: "renewal", title: "Call notes", content: "…" },
          reason: "",
        }),
      ),
    ).toBe('dana logged a note: "Call notes"');
    expect(
      describeEvent(
        event({
          twin: "google-docs",
          kind: "replace",
          payload: { documentRef: "brief", find: "TBC", replaceWith: "Thursday" },
          reason: "",
        }),
      ),
    ).toBe('dana revised "TBC" in "brief"');
    expect(
      describeEvent(
        event({
          twin: "google-ads",
          kind: "spend",
          payload: { adGroup: "Brand teams, UK", impressions: 10, clicks: 1, costMicros: 1_000_000 },
          reason: "",
        }),
      ),
    ).toBe('spend landed on "Brand teams, UK"');
    expect(
      describeEvent(
        event({
          twin: "linkedin",
          kind: "comment",
          payload: { postRef: "launch", text: "any update?" },
          personId: undefined,
          reason: "",
        }),
      ),
    ).toBe('the company page commented on a post: "any update?"');
  });
});

describe("runTimeline", () => {
  it("flattens the whole run in tick order", () => {
    const rows = runTimeline([
      record({ tick: 0, beatsFired: [fired({ beatId: "b0" })] }),
      record({ tick: 1, directorEvents: [event()] }),
    ]);
    expect(rows.map((r) => r.tick)).toEqual([0, 1]);
  });
});

describe("tickDigest", () => {
  it("says a surface changed and nothing whatever about what it says", () => {
    const digest = tickDigest([fired()], []);
    expect(digest).toBe("new mail in the inbox");
    // The subject line is the thing an agent must go and read for itself.
    expect(digest).not.toContain("freight");
    expect(digest).not.toContain("Dana");
  });

  it("counts repeats rather than listing them", () => {
    expect(tickDigest([fired(), fired({ beatId: "b2" })], [])).toBe("2× new mail in the inbox");
  });

  it("distinguishes a reaction from a message, because they mean different things", () => {
    const reaction = event({
      twin: "slack",
      kind: "reaction",
      payload: { messageRef: "r", from: "sam", emoji: "eyes" },
    });
    const message = event({
      twin: "slack",
      kind: "message",
      payload: { channel: "ops", from: "sam", text: "on it" },
    });
    expect(tickDigest([], [reaction])).toBe("a new reaction in Slack");
    expect(tickDigest([], [message])).toBe("new activity in Slack");
  });

  // Every twin that is not gmail, slack or calendar used to fall off the end of
  // a ternary chain and be announced as "a change on the calendar", which sends
  // an agent to look for a meeting that a CRM note caused.
  it("names the surface a beat actually landed on", () => {
    expect(tickDigest([fired({ twin: "attio", kind: "note" })], [])).toBe("a change in the CRM");
    expect(tickDigest([fired({ twin: "google-docs", kind: "append" })], [])).toBe(
      "a change in a document",
    );
    expect(tickDigest([fired({ twin: "google-ads", kind: "spend" })], [])).toBe(
      "a change in the ads account",
    );
    expect(tickDigest([fired({ twin: "linkedin", kind: "comment" })], [])).toBe(
      "new activity on LinkedIn",
    );
    // `reaction` happens on two surfaces and means something different on each.
    expect(tickDigest([fired({ twin: "linkedin", kind: "reaction" })], [])).toBe(
      "a new reaction on LinkedIn",
    );
  });

  it("counts only what landed", () => {
    expect(tickDigest([fired({ error: "500" })], [event({ error: "nope" })])).toBe(
      "Nothing new has arrived since the last check.",
    );
    expect(tallyLanded([fired({ error: "500" })], [])).toEqual(new Map());
  });

  it("keeps first-occurrence order across both sources", () => {
    const calendar = event({
      twin: "calendar",
      kind: "rsvp",
      payload: { eventRef: "r", who: "dana", response: "declined" },
    });
    expect([...tallyLanded([fired()], [calendar, event()]).keys()]).toEqual([
      "new mail in the inbox",
      "a change on the calendar",
    ]);
    expect(tickDigest([fired()], [calendar, event()])).toBe(
      "2× new mail in the inbox; a change on the calendar",
    );
  });
});

describe("recentHistory", () => {
  it("returns the tail, oldest first, and everything when there is less than the cap", () => {
    const ticks = [0, 1, 2, 3].map((tick) => record({ tick, beatsFired: [fired({ beatId: `b${tick}` })] }));
    expect(recentHistory(ticks, 2).map((r) => r.tick)).toEqual([2, 3]);
    expect(recentHistory(ticks, 99).map((r) => r.tick)).toEqual([0, 1, 2, 3]);
    expect(recentHistory([], 5)).toEqual([]);
  });
});
