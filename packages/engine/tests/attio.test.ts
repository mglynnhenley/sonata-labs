import { describe, it, expect } from "vitest";
import type { AttioSnapshot } from "@sonata/core";
import { diffAttio, renderAttioDiff } from "../src/adapters/attio";

// The CRM diff, offline — the half of the adapter an old artifact is re-judged
// through months after the twin that produced it stopped running.
//
// What these pin is the part of the contract a judge reads as prose: that a note
// names the account it was filed against rather than a UUID, and that a follow-up
// says who it landed on. Both were unreadable in the first cut of the contract,
// and both are facts the same snapshot already holds.

type Record_ = AttioSnapshot["records"][number];

const snap = (over: Partial<AttioSnapshot> = {}): AttioSnapshot => ({
  twin: "attio",
  capturedAt: 0,
  records: [],
  notes: [],
  tasks: [],
  ...over,
});

const record = (over: Partial<Record_> & { recordId: string }): Record_ => ({
  object: "deals",
  title: "Brightline expansion",
  values: {},
  ...over,
});

describe("attio diff", () => {
  it("names the record a note was filed against, even when nothing else touched it", () => {
    // The likeliest beat on this surface, and the one the diff alone cannot
    // answer: the account is unchanged, so it appears in no other row.
    const untouched = [record({ recordId: "r1", object: "companies", title: "Vertex Logistics" })];
    const before = snap({ records: untouched });
    const after = snap({
      records: untouched,
      notes: [
        {
          noteId: "n1",
          parentObject: "companies",
          parentRecordId: "r1",
          title: "Chased the buyer",
          excerpt: "Left a voicemail.",
        },
      ],
    });

    expect(diffAttio(before, after).notesAdded).toEqual([
      {
        noteId: "n1",
        parentObject: "companies",
        parentRecordId: "r1",
        parentTitle: "Vertex Logistics",
        title: "Chased the buyer",
        excerpt: "Left a voicemail.",
      },
    ]);
  });

  it("falls back to the id for a parent the capture never held", () => {
    // A record past the per-object cap is not in the snapshot to be named, and a
    // wrong name would be worse than a raw id.
    const after = snap({
      notes: [
        {
          noteId: "n1",
          parentObject: "deals",
          parentRecordId: "beyond-the-cap",
          title: "Note",
          excerpt: "",
        },
      ],
    });
    expect(diffAttio(snap(), after).notesAdded[0]?.parentTitle).toBe("beyond-the-cap");
  });

  it("carries a new follow-up's assignees, so the diff can answer 'for whom'", () => {
    const after = snap({
      tasks: [
        {
          taskId: "t1",
          content: "Send the revised quote",
          isCompleted: false,
          deadlineISO: "2026-08-05T09:00:00Z",
          assignees: ["priya@northwind.test"],
        },
      ],
    });
    expect(diffAttio(snap(), after).tasksAdded).toEqual([
      {
        taskId: "t1",
        content: "Send the revised quote",
        deadlineISO: "2026-08-05T09:00:00Z",
        assignees: ["priya@northwind.test"],
      },
    ]);
  });

  it("credits the agent only with a task it actually closed", () => {
    const open = { taskId: "t1", content: "Call back", isCompleted: false, assignees: [] };
    const done = { ...open, isCompleted: true };
    // Arrived already finished: never open, so never closed by this agent.
    expect(diffAttio(snap({ tasks: [done] }), snap({ tasks: [done] })).tasksCompleted).toEqual([]);
    expect(diffAttio(snap({ tasks: [open] }), snap({ tasks: [done] })).tasksCompleted).toEqual([
      { taskId: "t1", content: "Call back" },
    ]);
  });

  it("renders as prose a person can check", () => {
    const before = snap({
      records: [record({ recordId: "r1", values: { stage: "Negotiation" } })],
    });
    const after = snap({
      records: [record({ recordId: "r1", values: { stage: "Won" } })],
      notes: [
        {
          noteId: "n1",
          parentObject: "deals",
          parentRecordId: "r1",
          title: "Signed",
          excerpt: "Order form in.",
        },
      ],
      tasks: [{ taskId: "t1", content: "Tidy the pipeline", isCompleted: false, assignees: [] }],
    });

    expect(renderAttioDiff(diffAttio(before, after))).toBe(
      [
        '~ "Brightline expansion" stage: Negotiation → Won',
        '+ note "Signed" on "Brightline expansion": Order form in.',
        // Both halves of an unowned, undated follow-up are findings themselves.
        '+ task "Tidy the pipeline" assigned to nobody with no deadline',
        "0 record(s) untouched",
      ].join("\n"),
    );
  });
});
