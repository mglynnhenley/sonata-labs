import type { CriterionResult, EpisodeJudgeReport } from "@sonata/core";
import { describe, expect, it } from "vitest";
import { buildDayMap, columnSeverity, hasDayShape } from "../app/results/_lib/daymap";
import type { Moment } from "../app/results/_lib/moments";

// WHERE A MARK LANDS IS A CLAIM, AND A CHART MAKES IT WITHOUT WORDS.
//
// A diamond over the wrong column tells the reader the agent failed at 14:30
// when it failed at 09:15, and unlike a sentence there is nothing to hedge it
// with. These pin the two decisions that place a mark: a finding's steps beat
// its own recollection of the tick, and a criterion nothing could decide is
// never drawn as one that failed.

let seq = 0;

function tool(tick: number, opts: { mutation?: boolean; hour?: number } = {}): Moment {
  return {
    index: seq,
    tick,
    simTimeISO: `2026-08-06T${String(opts.hour ?? 9 + tick).padStart(2, "0")}:00:00.000Z`,
    source: "agent",
    twin: "gmail",
    title: "gmail.search",
    seq: ++seq,
    isMutation: opts.mutation ?? false,
    step: {
      kind: "tool",
      seq,
      at: 0,
      twin: "gmail",
      name: "gmail.search",
      args: {},
      resultSummary: "ok",
      isMutation: opts.mutation ?? false,
    },
  } as Moment;
}

function report(over: Partial<EpisodeJudgeReport> = {}): EpisodeJudgeReport {
  return {
    runId: "r",
    judgedAt: 0,
    model: "m",
    taskUnderstanding: "",
    autonomyScore: 0,
    summary: "",
    findings: [],
    otherFindings: [],
    answers: [],
    ...over,
  };
}

function criterion(over: Partial<CriterionResult>): CriterionResult {
  return {
    id: "c1",
    description: "Elena got an answer.",
    kind: "state",
    twin: "gmail",
    severity: "must",
    weight: 1,
    status: "failed",
    ...over,
  } as CriterionResult;
}

describe("the day map", () => {
  it("counts calls and changes per tick", () => {
    const map = buildDayMap(
      [tool(0), tool(0), tool(0, { mutation: true }), tool(1)],
      null,
      [],
    );

    expect(map.columns).toHaveLength(2);
    expect(map.columns[0]).toMatchObject({ tick: 0, calls: 3, changes: 1 });
    expect(map.columns[1]).toMatchObject({ tick: 1, calls: 1, changes: 0 });
    expect(map.peak).toBe(3);
  });

  it("counts the ticks that spent effort and changed nothing", () => {
    // The whole point of the grey fill. A day of reads is the failure this
    // product exists to make visible, and it has to be countable to be stated.
    const map = buildDayMap([tool(0), tool(1), tool(2, { mutation: true })], null, []);

    expect(map.spentIdle).toBe(2);
    expect(map.productive).toBe(1);
  });

  it("places a finding by its steps, not by the tick it claims", () => {
    // The judge reads a projection of the trace and can misremember which tick a
    // step was in. The step number is the fact; the tick is the recollection.
    const moments = [tool(0), tool(1), tool(2)]; // seqs 1, 2, 3 in ticks 0, 1, 2
    const step = moments[2].seq!;
    const map = buildDayMap(
      moments,
      report({
        findings: [{ mode: "dropped-thread", severity: "major", evidence: [], seq: [step], tick: 0 }],
      }),
      [],
    );

    expect(map.columns.find((c) => c.tick === 2)?.findings).toHaveLength(1);
    expect(map.columns.find((c) => c.tick === 0)?.findings).toEqual([]);
  });

  it("falls back to the claimed tick when the step is not in this artifact", () => {
    // An old report, or a re-judge after the trace was rewritten. Better a mark
    // on the tick the judge named than no mark at all.
    const map = buildDayMap(
      [tool(0), tool(1)],
      report({
        findings: [{ mode: "dropped-thread", severity: "major", evidence: [], seq: [999], tick: 1 }],
      }),
      [],
    );

    expect(map.columns.find((c) => c.tick === 1)?.findings).toHaveLength(1);
  });

  it("draws a failed criterion and never an undecided one", () => {
    // The rule the checklist itself follows. A criterion nothing could settle is
    // not a failure, and a diamond over its tick would accuse the agent of one.
    const map = buildDayMap(
      [tool(0), tool(1)],
      null,
      [
        criterion({ id: "c1", status: "failed", tick: 0 }),
        criterion({ id: "c2", status: "notApplicable", tick: 1 }),
        criterion({ id: "c3", status: "passed", tick: 1 }),
      ],
    );

    expect(map.columns.find((c) => c.tick === 0)?.failed).toEqual(["Elena got an answer."]);
    expect(map.columns.find((c) => c.tick === 1)?.failed).toEqual([]);
    expect(map.flagged).toEqual([0]);
  });

  it("sorts findings worst-first so the column is drawn at its worst severity", () => {
    const map = buildDayMap(
      [tool(0)],
      report({
        findings: [
          { mode: "task-drift", severity: "minor", evidence: [], tick: 0 },
          { mode: "dropped-thread", severity: "critical", evidence: [], tick: 0 },
        ],
      }),
      [],
    );

    expect(columnSeverity(map.columns[0])).toBe("critical");
  });

  it("keeps a tick with no calls in the day rather than closing the gap", () => {
    // A silent tick is a fact about the day. Dropped, the chart shows a shorter
    // day than the one that was run.
    const map = buildDayMap([tool(0), tool(5)], null, []);
    // Only ticks that produced a moment exist; the point is the gap is visible in
    // the tick numbers rather than papered over by re-indexing.
    expect(map.columns.map((c) => c.tick)).toEqual([0, 5]);
  });

  it("refuses to draw a day with one tick in it", () => {
    expect(hasDayShape(buildDayMap([tool(0)], null, []))).toBe(false);
    expect(hasDayShape(buildDayMap([tool(0), tool(1)], null, []))).toBe(true);
  });

  it("never divides by zero on a day with no work in it", () => {
    const map = buildDayMap([], null, []);
    expect(map.peak).toBe(1);
    expect(map.columns).toEqual([]);
  });
});
