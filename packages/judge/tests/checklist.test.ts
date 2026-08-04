import type { ChecklistInput } from "../src/checklist";
import { describe, expect, it } from "vitest";
import {
  escalationsFromTicks,
  factNameFor,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "../src/checklist";
import {
  auditRow,
  calendarSnapshot,
  criterion,
  gmailSnapshot,
  resetSeq,
  slackSnapshot,
  tickRecord,
  toolStep,
  WORLD,
} from "./fixtures";

// Every criterion must come back with the evidence that settled it — a bare
// pass/fail is a dead end on the results page, and a failure with no explanation is
// indistinguishable from a broken checker.

function base(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    criteria: [],
    world: WORLD,
    refs: { escalation: { twin: "gmail", id: "M1", containerId: "T1" } },
    snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
    audit: [],
    escalations: [],
    ...over,
  };
}

describe("factNameFor", () => {
  it("routes each (twin, kind) pair to a named provider", () => {
    expect(factNameFor("gmail", "replied")).toBe("gmail:replied_in_thread");
    expect(factNameFor("slack", "posted")).toBe("slack:posted_in_channel");
    expect(factNameFor("calendar", "moved")).toBe("calendar:event_rescheduled");
  });

  it("treats escalation as a property of the agent, not of a surface", () => {
    expect(factNameFor("gmail", "no-escalation")).toBe("any:no_escalation");
    expect(factNameFor("calendar", "no-escalation")).toBe("any:no_escalation");
  });

  it("has nothing for a judged criterion, and nothing for a nonsense pair", () => {
    expect(factNameFor("gmail", "judged")).toBeNull();
    expect(factNameFor("gmail", "scheduled")).toBeNull();
  });
});

describe("runChecklist", () => {
  it("passes a reply criterion on the audit row, and quotes it", () => {
    const { results } = runChecklist(
      base({ criteria: [criterion()], audit: [auditRow()], tickOf: () => 2 }),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].evidence).toContain("[audit 1]");
    expect(results[0].evidence).toContain("replied to Dana Reyes on T1");
    expect(results[0].tick).toBe(2);
  });

  it("fails a reply criterion with evidence naming what it looked for", () => {
    const { results } = runChecklist(base({ criteria: [criterion()] }));
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain('beat ref "escalation"');
    expect(results[0].evidence).toContain("T1");
  });

  it("accepts a reply the twin logged oddly, on the thread's message count", () => {
    const after = gmailSnapshot();
    after.threads[0].count = 2;
    const { results } = runChecklist(
      base({
        criteria: [criterion()],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
        audit: [auditRow({ actionType: "unrecognised_verb" })],
      }),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].evidence).toContain("grew from 1 to 2 messages");
  });

  it("does not count an unsent draft as a send, and says the draft is there", () => {
    const after = gmailSnapshot({
      drafts: [
        { draftId: "D1", to: ["dana@brightline.test"], subject: "Re: SLA", excerpt: "Hi Dana" },
      ],
    });
    const { results } = runChecklist(
      base({
        criteria: [criterion({ kind: "sent", target: "dana", ref: undefined })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
      }),
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("an unsent draft to dana@brightline.test exists");
  });

  it("checks a label against the final mailbox and lists what was there instead", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["INBOX", "Client"];
    const input = base({
      criteria: [criterion({ kind: "labelled", expect: "Client" })],
      snapshots: { gmail: { before: gmailSnapshot(), after } },
    });
    expect(runChecklist(input).results[0]).toMatchObject({ passed: true });

    const missed = runChecklist({
      ...input,
      criteria: [criterion({ kind: "labelled", expect: "Escalation" })],
    });
    expect(missed.results[0].passed).toBe(false);
    expect(missed.results[0].evidence).toContain("INBOX, Client");
  });

  it("treats a thread out of the inbox as archived", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["Client"];
    const { results } = runChecklist(
      base({
        criteria: [criterion({ kind: "archived" })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
      }),
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails `untouched` and names every change it found", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["INBOX"];
    after.threads[0].unread = false;
    const { results } = runChecklist(
      base({
        criteria: [criterion({ kind: "untouched" })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
        audit: [auditRow({ actionType: "modify_labels" })],
      }),
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("read state changed");
    expect(results[0].evidence).toContain("[audit 1]");
  });

  it("only credits Slack posts the mailbox owner made, not the world's chatter", () => {
    const after = slackSnapshot({
      messages: [
        ...slackSnapshot().messages,
        {
          channelId: "C01OPS",
          channelName: "ops",
          ts: "200.1",
          user: "U01SAM",
          text: "Taking the Tuesday run — I have Dana.",
          replyCount: 0,
          reactions: [],
        },
      ],
    });
    const input = base({
      criteria: [criterion({ twin: "slack", kind: "posted", expect: "#ops", ref: undefined })],
      snapshots: { slack: { before: slackSnapshot(), after } },
    });
    const { results } = runChecklist(input);
    expect(results[0].passed).toBe(true);
    expect(results[0].evidence).toContain("Taking the Tuesday run");

    const silent = runChecklist({
      ...input,
      snapshots: { slack: { before: slackSnapshot(), after: slackSnapshot() } },
    });
    expect(silent.results[0].passed).toBe(false);
  });

  it("sees a rescheduled event, and reports both times", () => {
    const after = calendarSnapshot();
    after.events[0].startISO = "2026-08-04T16:00:00Z";
    const { results } = runChecklist(
      base({
        criteria: [criterion({ twin: "calendar", kind: "moved", ref: "review" })],
        refs: { review: { twin: "calendar", id: "E1" } },
        snapshots: { calendar: { before: calendarSnapshot(), after } },
      }),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].evidence).toContain("14:00:00Z to 2026-08-04T16:00:00Z");
  });

  it("finds a phrase in what the agent wrote, not in what it was sent", () => {
    const written = [
      { twin: "gmail" as const, source: "send_reply", text: "A credit note is on its way.", tick: 3 },
    ];
    const { results } = runChecklist(
      base({
        criteria: [criterion({ twin: "any", kind: "mentions", expect: "credit note", ref: undefined })],
        written,
      }),
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].tick).toBe(3);
    expect(results[0].evidence).toContain("send_reply");
  });

  it("passes no-escalation only when the agent never handed back", () => {
    const c = criterion({ twin: "any", kind: "no-escalation", ref: undefined });
    expect(runChecklist(base({ criteria: [c] })).results[0].passed).toBe(true);

    const handed = runChecklist(
      base({ criteria: [c], escalations: [{ tick: 4, text: "Sam, please decide" }] }),
    );
    expect(handed.results[0]).toMatchObject({ passed: false, tick: 4 });
    expect(handed.results[0].evidence).toContain("Sam, please decide");
  });

  it("defers judged criteria instead of failing them", () => {
    const { results, deferred } = runChecklist(
      base({ criteria: [criterion({ id: "c9", kind: "judged" })] }),
    );
    expect(results).toEqual([]);
    expect(deferred.map((c) => c.id)).toEqual(["c9"]);
  });

  it("fails loudly, never silently passes, on a (twin, kind) pair with no checker", () => {
    const { results } = runChecklist(
      base({ criteria: [criterion({ twin: "gmail", kind: "scheduled" })] }),
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("no deterministic checker exists for gmail/scheduled");
  });

  it("says which snapshot is missing rather than throwing", () => {
    const { results } = runChecklist(
      base({ criteria: [criterion({ twin: "calendar", kind: "cancelled" })], snapshots: {} }),
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("no calendar snapshot");
  });

  it("carries severity and weight through unchanged, for scoring", () => {
    const { results } = runChecklist(
      base({ criteria: [criterion({ weight: 3, severity: "should" })] }),
    );
    expect(results[0]).toMatchObject({ weight: 3, severity: "should", twin: "gmail" });
  });
});

describe("deriving checklist input from a run", () => {
  it("maps beat refs to what the twin actually created", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [
          {
            beatId: "b1",
            ref: "escalation",
            twin: "gmail",
            kind: "email",
            summary: "Dana emailed",
            handle: { twin: "gmail", id: "M1", containerId: "T1" },
          },
          { beatId: "b2", ref: "lost", twin: "slack", kind: "message", summary: "x", error: "500" },
        ],
      }),
    ];
    const refs = refsFromTicks(ticks);
    expect(refs.escalation.containerId).toBe("T1");
    // A beat that failed to inject minted nothing, so it must not resolve.
    expect(refs.lost).toBeUndefined();
  });

  it("lifts what the agent wrote out of its mutating tool arguments", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 1,
        agentSteps: [
          toolStep({ args: { threadId: "T1", body: "A credit note is on its way." } }),
          toolStep({ name: "get_thread", isMutation: false, args: { threadId: "T1" } }),
          toolStep({ args: { body: "never landed" }, error: "429" }),
        ],
      }),
    ];
    const written = writtenFromTicks(ticks);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ twin: "gmail", tick: 1 });
    expect(written[0].text).toContain("credit note");
  });

  it("collects escalations with the tick they happened on", () => {
    const ticks = [
      tickRecord({
        tick: 5,
        agentSteps: [{ kind: "escalation", seq: 1, at: 1, text: "over my head" }],
      }),
    ];
    expect(escalationsFromTicks(ticks)).toEqual([{ tick: 5, text: "over my head" }]);
  });

  it("attributes an audit row to its tick, and refuses to attribute the seeding", () => {
    const at = tickIndexer([tickRecord({ tick: 0 }), tickRecord({ tick: 1 })]);
    expect(at(1050)).toBe(0);
    expect(at(1150)).toBe(1);
    expect(at(10)).toBeUndefined();
  });
});
