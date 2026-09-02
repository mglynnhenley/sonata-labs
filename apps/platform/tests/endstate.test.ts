import { describe, expect, it } from "vitest";
import type { EpisodeRun, Person, TickRecord, TwinSnapshot } from "@sonata/core";
import { endOfDay, type EndStateInput } from "../app/results/_components/endstate";

// WHERE THE DAY ENDED UP, on the two surfaces that landed after the first three.
//
// The rule this section keeps to is that every number is read off the closing
// snapshot's own list and every omission is admitted. These tests hold it to
// that: what counts as still OPEN on each surface, and — as importantly — what
// the snapshot cannot say, which has to appear as a scope note rather than as a
// confident zero.

const CAST: Person[] = [
  {
    id: "chris",
    name: "Chris Vane",
    email: "chris@momentum.test",
    slackUserId: "U01CHRIS",
    role: "Ops Lead",
    relationship: "self",
    voice: "brisk",
  },
  {
    id: "priya",
    name: "Priya Raman",
    email: "priya@momentum.test",
    slackUserId: "U01PRIYA",
    role: "Account Manager",
    relationship: "colleague",
    voice: "warm",
  },
];

function tick(n: number): TickRecord {
  return {
    tick: n,
    simTimeISO: `2026-08-06T${String(9 + n).padStart(2, "0")}:00:00.000Z`,
    startedAt: 1_700_000_000_000 + n,
    endedAt: 1_700_000_000_500 + n,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [],
    notes: [],
  };
}

/** One surface's closing picture, with nothing else in the run to distract. */
function report(after: TwinSnapshot) {
  const snapshots = { [after.twin]: { after } } as EpisodeRun["snapshots"];
  const input: EndStateInput = {
    snapshots,
    ticks: [tick(0), tick(1)],
    cast: CAST,
    evidence: [{ twin: after.twin, after: true }],
    offsetMinutes: 0,
    judge: null,
  };
  const [twin] = endOfDay(input).twins;
  if (!twin) throw new Error(`no end state for ${after.twin}`);
  return twin;
}

describe("the CRM at close", () => {
  it("counts the follow-ups nobody closed, and never calls a record itself open", () => {
    const end = report({
      twin: "attio",
      capturedAt: 2000,
      records: [
        { recordId: "r1", object: "deals", title: "Brightline expansion", values: { stage: "Won" } },
      ],
      notes: [],
      tasks: [
        {
          taskId: "t1",
          content: "Chase the signed order form",
          isCompleted: false,
          deadlineISO: "2026-08-06T16:00:00.000Z",
          assignees: ["priya@momentum.test"],
        },
        { taskId: "t2", content: "Already done", isCompleted: true, assignees: [] },
      ],
    });

    expect(end.counts).toEqual([
      { label: "record", value: 1, flag: false },
      { label: "follow-up still open", value: 1, flag: true },
    ]);
    // A record is the file the work is about, not outstanding work.
    expect(end.open.map((o) => o.what)).toEqual(["Chase the signed order form"]);
    expect(end.open[0]?.who).toBe("Priya Raman");
    expect(end.open[0]?.when).toBe("16:00");
  });

  it("tells a follow-up nobody dated from one that is merely open", () => {
    const end = report({
      twin: "attio",
      capturedAt: 2000,
      records: [],
      notes: [],
      tasks: [{ taskId: "t1", content: "Tidy the pipeline", isCompleted: false, assignees: [] }],
    });
    expect(end.open[0]?.why).toBe("follow-up with no deadline on it");
    expect(end.open[0]?.who).toBe("");
  });
});

describe("the workspace at close", () => {
  it("flags a document that was started and never written", () => {
    const end = report({
      twin: "google-docs",
      capturedAt: 2000,
      documents: [
        {
          documentId: "d1",
          title: "Q3 brief",
          revisionId: "r2",
          ownerEmail: "priya@momentum.test",
          excerpt: "Owner: Priya",
          characterCount: 240,
        },
        {
          documentId: "d2",
          title: "Handover",
          revisionId: "r1",
          ownerEmail: "chris@momentum.test",
          excerpt: "",
          characterCount: 0,
        },
      ],
    });

    expect(end.counts).toEqual([
      { label: "documents", value: 2, flag: false },
      { label: "document left empty", value: 1, flag: true },
    ]);
    expect(end.open).toEqual([
      {
        key: "empty-d2",
        what: "Handover",
        who: "Chris Vane",
        when: "",
        why: "started, never written",
      },
    ]);
  });
});
