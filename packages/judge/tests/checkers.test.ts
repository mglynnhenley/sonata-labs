import { describe, expect, it } from "vitest";
import type { ChecklistInput } from "../src/checklist";
import { runChecklist } from "../src/checklist";
import {
  auditRow,
  calendarSnapshot,
  criterion,
  gmailSnapshot,
  slackSnapshot,
  WORLD,
} from "./fixtures";

// The checker table, cell by cell.
//
// Two things are being defended here. The first is coverage: a (twin, kind) pair
// with no checker cannot be answered, and a checklist of unanswerable criteria is
// how a run where the agent sent nothing all day was published "Passed, 100%".
// The second, and the one worth more, is that each cell answers ITS OWN question:
// a draft is not a send, a reaction the agent later removed is not a reaction, and
// an attendee who was already on the invite was not invited by the agent.

function input(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    criteria: [],
    world: WORLD,
    refs: {},
    snapshots: {},
    audit: [],
    escalations: [],
    agentActed: true,
    ...over,
  };
}

/** The Slack message a beat posted, as the snapshot carries it. */
function slackWith(reactions: string[]) {
  return slackSnapshot({
    messages: [
      {
        channelId: "C01OPS",
        channelName: "ops",
        ts: "100.1",
        user: "U01DANA",
        text: "who is on the Tuesday run?",
        replyCount: 0,
        reactions,
      },
    ],
  });
}

const REACT_ROW = auditRow({
  twin: "slack",
  method: "POST",
  endpoint: "reactions.add",
  actionType: "react",
  targetType: "message",
  targetId: "C01OPS/100.1",
  summary: "added :eyes: in #ops",
});

// ---------------------------------------------------------------------------
// A DRAFT IS NOT A SEND. The run that opened this pass drafted four refund
// approvals, sent none, told itself it had "processed all refund requests", and
// was stamped passed. Both directions are asserted, because a checker that fails
// everything is not a fix.
// ---------------------------------------------------------------------------

describe("a reply that was written and never sent", () => {
  /**
   * The shape a real run has: the thread arrived on a beat during the day, so it
   * is in the AFTER snapshot only — the `before` snapshot is taken before tick 0.
   */
  const threadFromABeat = {
    refs: { corsair: { twin: "gmail" as const, id: "M9", containerId: "T9" } },
    snapshots: {
      gmail: {
        before: gmailSnapshot({ threads: [] }),
        after: gmailSnapshot({
          threads: [
            {
              threadId: "T9",
              subject: "Double charge on invoice 4471",
              from: "dave@corsair.test",
              date: 900,
              labels: ["INBOX"],
              unread: true,
              starred: false,
              count: 2,
            },
          ],
          drafts: [
            {
              draftId: "D1",
              threadId: "T9",
              to: ["dave@corsair.test"],
              subject: "Re: Double charge on invoice 4471",
              excerpt: "We have approved your refund of $4,000.",
            },
          ],
        }),
      },
    },
    criteria: [criterion({ kind: "replied", ref: "corsair" })],
  };

  it("fails, and says the draft is sitting there unsent", () => {
    const { results } = runChecklist(input(threadFromABeat));

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("WRITTEN AND NEVER SENT");
    expect(results[0].evidence).toContain("D1");
    // The count grew — the draft IS a message in its thread — and that must not be
    // read as a reply. This assertion is the whole bug.
    expect(results[0].evidence).not.toContain("grew");
  });

  it("passes the same thread once the draft is actually sent", () => {
    const { results } = runChecklist(
      input({
        ...threadFromABeat,
        audit: [
          auditRow({
            actionType: "draftSend",
            targetType: "message",
            targetId: "M11",
            summary: "Sent draft D1 → “Re: Double charge on invoice 4471”",
          }),
        ],
      }),
    );

    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("Double charge on invoice 4471");
  });

  it("nets the draft out of a thread that was already in the mailbox", () => {
    // The other half of the same trap: on a thread the agent was shown at tick 0,
    // a drafted reply still grows `count` by one. Netting drafts off BOTH counts is
    // what stops "the thread grew" from meaning "the client got an answer".
    const after = gmailSnapshot({
      drafts: [
        {
          draftId: "D2",
          threadId: "T1",
          to: ["dana@brightline.test"],
          subject: "Re: SLA breach on the Tuesday run",
          excerpt: "We are looking into it.",
        },
      ],
    });
    after.threads[0].count = 2;

    const { results } = runChecklist(
      input({
        refs: { escalation: { twin: "gmail", id: "M1", containerId: "T1" } },
        criteria: [criterion()],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
      }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("WRITTEN AND NEVER SENT");
    expect(results[0].evidence).toContain("D2");
  });

  it("does not read a draft the agent created as a reply, even in the log", () => {
    // `draftCreate` contains "draft" and so does `draftSend`; only one of them put
    // something on the wire, and a /send/ regex over the action type gets that
    // wrong by luck rather than by reading.
    const { results } = runChecklist(
      input({
        ...threadFromABeat,
        audit: [
          auditRow({
            actionType: "draftCreate",
            targetType: "draft",
            targetId: "D1",
            summary: "Created draft “Re: Double charge on invoice 4471”",
          }),
        ],
      }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("WRITTEN AND NEVER SENT");
  });
});

describe("a reply the log records against the new message rather than the thread", () => {
  it("still passes, on the subject the reply carries", () => {
    // Gmail's `send` row names the message it minted; the thread it joined is
    // nowhere on the row. Every `replied` criterion names a beat-created thread,
    // which is in neither `before` nor the count route — so without the subject
    // this real, sent reply came back "no reply landed".
    const { results } = runChecklist(
      input({
        refs: { corsair: { twin: "gmail", id: "M9", containerId: "T9" } },
        criteria: [criterion({ kind: "replied", ref: "corsair" })],
        snapshots: {
          gmail: {
            before: gmailSnapshot({ threads: [] }),
            after: gmailSnapshot({
              threads: [
                {
                  threadId: "T9",
                  subject: "Double charge on invoice 4471",
                  from: "dave@corsair.test",
                  date: 900,
                  labels: ["INBOX"],
                  unread: false,
                  starred: false,
                  count: 2,
                },
              ],
            }),
          },
        },
        audit: [
          auditRow({
            actionType: "send",
            targetType: "message",
            targetId: "M11",
            summary: "Sent “Re: Double charge on invoice 4471” to dave@corsair.test",
          }),
        ],
        tickOf: () => 4,
      }),
    );

    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("[audit 1]");
    expect(results[0].evidence).toContain("on the subject of");
    expect(results[0].tick).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The two cells that had no checker at all.
// ---------------------------------------------------------------------------

describe("slack/labelled — a reaction is this twin's label", () => {
  const react = (over: Partial<ChecklistInput> = {}): ChecklistInput =>
    input({
      refs: { standup: { twin: "slack", id: "100.1", containerId: "C01OPS" } },
      criteria: [criterion({ twin: "slack", kind: "labelled", ref: "standup", expect: "eyes" })],
      ...over,
    });

  it("passes on the reaction the message ends the day carrying, and quotes the row", () => {
    const { results } = runChecklist(
      react({
        snapshots: { slack: { before: slackWith([]), after: slackWith(["eyes:1"]) } },
        audit: [REACT_ROW],
      }),
    );

    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("[audit 1]");
    expect(results[0].evidence).toContain(":eyes:");
  });

  it("fails when the message carries something else, and lists what", () => {
    const { results } = runChecklist(
      react({
        snapshots: { slack: { before: slackWith([]), after: slackWith(["thumbsup:1"]) } },
      }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("thumbsup:1");
  });

  it("fails when the agent reacted and then took it back", () => {
    const { results } = runChecklist(
      react({
        snapshots: { slack: { before: slackWith([]), after: slackWith([]) } },
        audit: [
          REACT_ROW,
          auditRow({
            id: 2,
            twin: "slack",
            endpoint: "reactions.remove",
            actionType: "unreact",
            targetId: "C01OPS/100.1",
            summary: "removed :eyes: in #ops",
          }),
        ],
      }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("took it back");
  });

  it("says so rather than accusing the agent when the message was never captured", () => {
    const { results } = runChecklist(
      react({ snapshots: { slack: { before: slackSnapshot(), after: slackSnapshot({ messages: [] }) } } }),
    );

    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("not in the Slack capture");
  });
});

describe("calendar/sent — an invitation is what a calendar sends", () => {
  const invite = (over: Partial<ChecklistInput> = {}): ChecklistInput =>
    input({
      criteria: [criterion({ twin: "calendar", kind: "sent", target: "dana", ref: undefined })],
      ...over,
    });

  const debrief = {
    eventId: "E2",
    title: "Brightline debrief",
    startISO: "2026-08-04T16:00:00Z",
    endISO: "2026-08-04T16:30:00Z",
    organizer: "sam@northwind.test",
    attendees: [{ email: "dana@brightline.test", response: "needsAction" }],
    status: "confirmed" as const,
  };

  it("passes when the agent books a meeting with them on it", () => {
    const after = calendarSnapshot({ events: [...calendarSnapshot().events, debrief] });
    const { results } = runChecklist(
      invite({ snapshots: { calendar: { before: calendarSnapshot(), after } } }),
    );

    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("Brightline debrief");
    expect(results[0].evidence).toContain("dana@brightline.test");
  });

  it("fails a meeting booked without them, and names who is in the room instead", () => {
    const empty = { ...debrief, attendees: [{ email: "chris@northwind.test", response: "accepted" }] };
    const after = calendarSnapshot({ events: [...calendarSnapshot().events, empty] });
    const { results } = runChecklist(
      invite({ snapshots: { calendar: { before: calendarSnapshot(), after } } }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("chris@northwind.test");
  });

  it("will not credit the agent for an attendee who was already on the event", () => {
    // The fixture's standing review already has Dana on it. Reading the final
    // guest list alone would pay the agent for the world's own seeding.
    const { results } = runChecklist(
      invite({
        refs: { review: { twin: "calendar", id: "E1" } },
        criteria: [
          criterion({ twin: "calendar", kind: "sent", target: "dana", ref: "review" }),
        ],
        snapshots: { calendar: { before: calendarSnapshot(), after: calendarSnapshot() } },
      }),
    );

    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("already on");
  });
});

// ---------------------------------------------------------------------------
// What the row SAYS, when nothing could be decided. Every one of these was a
// misleading sentence on the report that opened this pass.
// ---------------------------------------------------------------------------

describe("a criterion whose beat never fired", () => {
  it("says the beat left nothing behind, not that the criterion named no beat", () => {
    // The report said "it names no beat ref" under three criteria that all named
    // one: their beats were scheduled for ticks the run never reached.
    const { results } = runChecklist(
      input({
        criteria: [criterion({ kind: "replied", ref: "corsair_email" })],
        refs: {},
        snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
      }),
    );

    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain('beat "corsair_email"');
    expect(results[0].evidence).toContain("never fired");
    expect(results[0].evidence).not.toContain("names no beat ref");
  });
});

describe("a Slack reply that landed outside the thread", () => {
  it("fails, and says where the answer actually went", () => {
    const after = slackSnapshot({
      messages: [
        ...slackSnapshot().messages,
        {
          channelId: "C01OPS",
          channelName: "ops",
          ts: "200.1",
          user: "U01SAM",
          text: "refunds are done, $8,200/mo of ARR at risk",
          replyCount: 0,
          reactions: [],
        },
      ],
    });
    const { results } = runChecklist(
      input({
        refs: { james: { twin: "slack", id: "100.1", containerId: "C01OPS" } },
        criteria: [criterion({ twin: "slack", kind: "replied", ref: "james" })],
        snapshots: { slack: { before: slackSnapshot(), after } },
      }),
    );

    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("OUTSIDE it");
    expect(results[0].evidence).toContain("refunds are done");
  });
});

describe("a (twin, kind) pair the table does not implement", () => {
  it("goes to the judge as a question AND stays on the checklist as unverified", () => {
    // Neither half is optional. Without the question nobody ever answers the
    // criterion; without the row a `must` leaves the checklist silently, which is
    // how a run with three undecided musts came out at 100%.
    const c = criterion({ twin: "gmail", kind: "scheduled", expect: "refund debrief" });
    // Its beat has to have fired, or this is a criterion about a moment the agent
    // never saw — a harness defect, which is settled before any checker is looked up.
    const { results, deferred } = runChecklist(
      input({
        criteria: [c],
        refs: { escalation: { twin: "gmail", id: "M1", containerId: "T1" } },
      }),
    );

    expect(deferred.map((d) => d.id)).toEqual(["c1"]);
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("no deterministic checker exists for gmail/scheduled");
    expect(results[0].evidence).toContain("put to the judge");
  });
});
