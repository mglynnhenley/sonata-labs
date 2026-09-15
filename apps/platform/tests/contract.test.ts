import { describe, expect, it } from "vitest";
import { episodeTwins } from "@sonata/core";
import { taxWorkbookDay } from "@sonata/scenarios";
import { buildContract, NOT_DECLARED } from "../app/scenarios/_lib/contract";

// The contract is what a practitioner reads before running the tax day, so it
// must state the shipped spec's real deadlines and limits, and admit what the
// authoring format does not declare rather than fill the gap with prose.
describe("scenario contract", () => {
  const contract = buildContract(taxWorkbookDay, episodeTwins(taxWorkbookDay));
  const [role, deliverables, review, facts, events, harness] = contract.sections;
  const text = (section: { groups: Array<{ items: string[] }> }) => section.groups.flatMap((g) => g.items).join("\n");

  it("lists every checklist criterion with its deadline read as the judge reads it", () => {
    expect(deliverables.deliverables).toHaveLength(12);
    const byId = new Map(deliverables.deliverables!.map((row) => [row.id, row]));
    expect(byId.get("tw-c01")!.deadline).toBe("12:00");
    expect(byId.get("tw-c02")!.deadline).toBe("18:00");
    expect(byId.get("tw-c03")!.deadline).toBe("by end of day");
    expect(byId.get("tw-c01")!.settledBy).toContain("checked automatically");
    expect(byId.get("tw-c03")!.settledBy).toContain("judged");
  });

  it("surfaces what the spec itself marks unmeasured", () => {
    const declared = facts.groups.find((g) => g.heading === "Declared unmeasured")!.items;
    expect(declared.some((item) => item.startsWith("tw-c10:"))).toBe(true);
    expect(declared.some((item) => item.includes("UNMEASURED"))).toBe(true);
    expect(text(facts)).toContain(taxWorkbookDay.success.judgeQuestions[0]);
  });

  it("describes the Inspect context policy and points to the recorded run configuration", () => {
    const body = text(harness);
    expect(body).toContain("exact cap is recorded in the Inspect log");
    expect(body).toContain("preserving the full transcript");
    expect(body).not.toContain("Built-in agent");
    expect(body).toContain("compressed wall time");
    expect(body).toContain("Agent, world (colleagues answering) and judge");
  });

  it("derives role, reviewers and fixed events from the spec", () => {
    expect(text(role)).toContain("The agent works as");
    expect(text(role)).toContain(taxWorkbookDay.task);
    expect(text(role)).toContain("Excel");
    expect(text(review)).toContain(taxWorkbookDay.director.offLimits[0]);
    expect(text(review)).toContain(NOT_DECLARED);
    expect(text(events)).toContain(`${taxWorkbookDay.beats.length} scheduled events from 09:00 to 17:30`);
  });

  it("renders a beat-ref deadline as the beat's time, and refuses to invent one for an unknown name", () => {
    const [handoff, unknown] = ["tw-handoff", "no-such-beat"].map((before) => {
      const copy = {
        ...taxWorkbookDay,
        success: {
          ...taxWorkbookDay.success,
          checklist: taxWorkbookDay.success.checklist.map((c) => (c.id === "tw-c02" ? { ...c, before } : c)),
        },
      };
      const [, rows] = buildContract(copy, episodeTwins(copy)).sections;
      return rows.deliverables!.find((row) => row.id === "tw-c02")!.deadline;
    });
    expect(handoff).toBe('before "tw-handoff" fires (17:30)');
    expect(unknown).toContain("the judge cannot settle this deadline");
  });

  it("states the step cap as a backstop, not a budget", () => {
    expect(text(harness)).toContain("turn cap is a runaway backstop");
  });

  it("says so when a spec declares no judge questions", () => {
    const bare = { ...taxWorkbookDay, success: { ...taxWorkbookDay.success, judgeQuestions: [] } };
    const [, , , bareFacts] = buildContract(bare, episodeTwins(bare)).sections;
    expect(bareFacts.groups[0].items).toEqual([`No judge questions are declared. Which facts are fictional instruction and which knowledge is tested is ${NOT_DECLARED}.`]);
  });
});
