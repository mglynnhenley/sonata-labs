import { describe, expect, it } from "vitest";
import type { EpisodeRun, Person, TickRecord, TwinSnapshot } from "@sonata/core";
import { endOfDay, endStateMarkdown, type EndStateInput } from "../app/results/_components/endstate";

// WHERE THE DAY ENDED UP, on the four surfaces that landed after the first three.
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

describe("workbooks at close", () => {
  it("reports revisions and complete attributed history without classifying changes as outstanding work", () => {
    const change = {
      id: 1, workbookId: "report", revision: 4, actor: "human reviewer", at: "2026-08-06T10:00:00Z",
      sheetId: "review", rowId: "row-1", column: "amount", before: 50, after: 65,
      reason: "Corrected the source amount", evidence: "Signed statement, line 7",
    };
    const end = report({
      twin: "excel", capturedAt: 2000,
      workbooks: [{ id: "report", title: "Quarterly reporting", revision: 4, sheets: [] }],
      changes: [change],
    });
    expect(end.counts).toEqual([
      { label: "workbook", value: 1, flag: false },
      { label: "recorded change", value: 1, flag: false },
    ]);
    expect(end.workbooks).toEqual([{ id: "report", title: "Quarterly reporting", revision: 4, sheets: 0 }]);
    expect(end.reviewHistory).toEqual([change]);
    expect(end.open).toEqual([]);
    expect(end.settled).toBe("");
    expect(end.scope).toContain("not a count of the agent's actions");
    expect(end.scope).toContain("do not establish");

    const markdown = endStateMarkdown({ closedAt: "10:00", twins: [end], unseen: [], sight: null });
    expect(markdown).toContain("Quarterly reporting — revision 4");
    expect(markdown).toContain("human reviewer");
    expect(markdown).toContain("50 → 65");
    expect(markdown).toContain(change.reason);
    expect(markdown).toContain(change.evidence);
  });

  it("does not turn an empty workbook capture into a clean verdict", () => {
    const end = report({ twin: "excel", capturedAt: 2000, workbooks: [], changes: [] });
    expect(end.counts.every((count) => count.value === 0 && !count.flag)).toBe(true);
    expect(end.settled).toBe("");
    const markdown = endStateMarkdown({ closedAt: "10:00", twins: [end], unseen: [], sight: null });
    expect(markdown).toContain("No changes are recorded in the closing snapshot.");
    expect(markdown).toContain("do not establish");
  });
});

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

describe("the ad account at close", () => {
  it("stops the reader at money switched off and at a campaign that cannot spend", () => {
    const end = report({
      twin: "google-ads",
      capturedAt: 2000,
      campaigns: [
        {
          campaignId: "c1",
          name: "Retargeting",
          status: "PAUSED",
          budgetId: "b1",
          budgetMicros: 15_000_000,
          costMicros: 0,
        },
        {
          campaignId: "c2",
          name: "Brand",
          status: "ENABLED",
          budgetId: "",
          budgetMicros: 0,
          costMicros: 318_940_000,
        },
      ],
    });

    expect(end.counts).toEqual([
      { label: "campaigns", value: 2, flag: false },
      { label: "left paused", value: 1, flag: true },
    ]);
    expect(end.open.map((o) => o.why)).toEqual([
      "paused when the day ended",
      "no budget attached, so it cannot spend",
    ]);
    // Spend is in the snapshot and covers a window several days wide, so it is
    // owned up to rather than printed under a heading about one day.
    expect(end.scope).toContain("a window several days wide");
  });
});

describe("the feed at close", () => {
  it("flags a post written and never published, and admits what it cannot know", () => {
    const end = report({
      twin: "linkedin",
      capturedAt: 2000,
      posts: [
        {
          postUrn: "urn:li:activity:1",
          author: "urn:li:person:chris",
          commentary: "We are hiring",
          lifecycleState: "PUBLISHED",
          commentCount: 1,
          reactionCount: 3,
        },
        {
          postUrn: "urn:li:activity:2",
          author: "urn:li:person:chris",
          commentary: "Draft about the new berth",
          lifecycleState: "DRAFT",
          commentCount: 0,
          reactionCount: 0,
        },
      ],
      comments: [
        {
          commentUrn: "urn:li:comment:9",
          postUrn: "urn:li:activity:1",
          actor: "urn:li:person:dana",
          text: "Is this remote?",
          isReply: false,
        },
      ],
    });

    expect(end.counts).toEqual([
      { label: "posts", value: 2, flag: false },
      { label: "comment", value: 1, flag: false },
      { label: "post left in draft", value: 1, flag: true },
    ]);
    expect(end.open.map((o) => o.what)).toEqual(["Draft about the new berth"]);
    // "Nobody answered this customer" is not a claim the capture can support: a
    // comment names its post, never the comment it replies to.
    expect(end.scope).toContain("never the comment it replies to");
  });
});
