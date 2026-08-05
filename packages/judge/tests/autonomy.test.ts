import type { CriterionResult } from "@sonata/core";
import { beforeEach, describe, expect, it } from "vitest";
import { autonomy } from "../src/autonomy";
import { directorEvent, resetSeq, tickRecord, toolStep } from "./fixtures";

// The arithmetic behind the headline number. Every expectation here is a claim
// about what the benchmark table means, so they are written as sentences.

function passed(n: number, weight = 1): CriterionResult[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    description: "done",
    twin: "gmail" as const,
    kind: "replied" as const,
    severity: "must" as const,
    weight,
    status: "passed" as const,
  }));
}

function failed(n: number, weight = 1): CriterionResult[] {
  return passed(n, weight).map((c, i) => ({ ...c, id: `f${i}`, status: "failed" as const }));
}

/** Criteria the run could not decide either way — restraint by an idle agent. */
function unverifiable(n: number, weight = 1): CriterionResult[] {
  return passed(n, weight).map((c, i) => ({
    ...c,
    id: `n${i}`,
    kind: "untouched" as const,
    status: "notApplicable" as const,
  }));
}

/** A beat arriving on tick 0, then `busy` ticks of work and `quiet` ticks of silence. */
function day(busy: number, quiet: number) {
  resetSeq();
  const ticks = [
    tickRecord({
      tick: 0,
      beatsFired: [{ beatId: "b1", ref: "escalation", twin: "gmail", kind: "email", summary: "Dana emailed" }],
    }),
  ];
  for (let i = 0; i < busy; i++) {
    ticks.push(tickRecord({ tick: ticks.length, agentSteps: [toolStep()] }));
  }
  for (let i = 0; i < quiet; i++) ticks.push(tickRecord({ tick: ticks.length }));
  return ticks;
}

describe("autonomy", () => {
  beforeEach(resetSeq);

  it("scores the do-nothing control at zero", () => {
    const ticks = day(0, 5);
    const result = autonomy(failed(3), ticks);

    expect(result.score).toBe(0);
    expect(result.stats.actions).toBe(0);
    // Tick 0 arrived and was ignored, and so was every tick after it.
    expect(result.stats.actionableTicks).toBe(6);
    expect(result.stats.stallTicks).toBe(6);
  });

  it("scores a run that finished everything without a human at one", () => {
    const result = autonomy(passed(3), day(4, 0));
    expect(result.score).toBe(1);
  });

  it("counts a single quiet tick as a pause, not a stall", () => {
    resetSeq();
    const ticks = [
      tickRecord({ tick: 0, beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }], agentSteps: [toolStep()] }),
      tickRecord({ tick: 1 }),
      tickRecord({ tick: 2, agentSteps: [toolStep()] }),
    ];
    expect(autonomy(passed(1), ticks).stats.stallTicks).toBe(0);
  });

  it("counts two consecutive silent ticks as a stall", () => {
    resetSeq();
    const ticks = [
      tickRecord({ tick: 0, beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }], agentSteps: [toolStep()] }),
      tickRecord({ tick: 1 }),
      tickRecord({ tick: 2 }),
      tickRecord({ tick: 3, agentSteps: [toolStep()] }),
    ];
    const stats = autonomy(passed(1), ticks).stats;
    expect(stats.stallTicks).toBe(2);
    expect(stats.longestStall).toBe(2);
  });

  it("ignores ticks before anything arrived — an empty morning is not a stall", () => {
    resetSeq();
    const ticks = [
      tickRecord({ tick: 0 }),
      tickRecord({ tick: 1 }),
      tickRecord({
        tick: 2,
        beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }],
        agentSteps: [toolStep()],
      }),
    ];
    expect(autonomy(passed(1), ticks).stats.actionableTicks).toBe(1);
  });

  it("docks independence in proportion to how often it handed back", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }],
        agentSteps: [
          toolStep(),
          { kind: "escalation", seq: 99, at: 1, text: "Sam, can you decide?" },
        ],
      }),
    ];
    const result = autonomy(passed(1), ticks);
    const independence = result.components.find((c) => c.id === "independence");
    expect(independence?.value).toBe(0.5);
    expect(result.stats.escalations).toBe(1);
  });

  it("only counts mutations as actions — reading is not doing", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }],
        agentSteps: [toolStep({ name: "get_thread", isMutation: false })],
      }),
    ];
    const stats = autonomy(passed(1), ticks).stats;
    expect(stats.actions).toBe(0);
    expect(stats.reads).toBe(1);
    // Reading still counts as working, so the tick is not a stall.
    expect(stats.stallTicks).toBe(0);
  });

  it("credits follow-through only when the agent acted after the world answered", () => {
    resetSeq();
    const answered = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }],
        agentSteps: [toolStep()],
        directorEvents: [directorEvent({ becauseSeq: 1 })],
      }),
      tickRecord({ tick: 1, agentSteps: [toolStep()] }),
    ];
    expect(autonomy(passed(1), answered).stats).toMatchObject({ exchanges: 1, exchangesCarried: 1 });

    const dropped = [
      answered[0],
      tickRecord({ tick: 1 }),
      tickRecord({ tick: 2 }),
    ];
    expect(autonomy(passed(1), dropped).stats).toMatchObject({ exchanges: 1, exchangesCarried: 0 });
  });

  it("does not count an exchange the agent was never given a tick to answer", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b", twin: "gmail", kind: "email", summary: "x" }],
        agentSteps: [toolStep()],
        directorEvents: [directorEvent({ becauseSeq: 1 })],
      }),
    ];
    const result = autonomy(passed(1), ticks);
    expect(result.stats.exchanges).toBe(0);
    expect(result.components.map((c) => c.id)).not.toContain("follow-through");
  });

  it("drops inapplicable components and redistributes their weight to sum to 1", () => {
    const result = autonomy(passed(2), day(3, 0));
    const total = result.components.reduce((s, c) => s + c.weight, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(result.components.map((c) => c.id)).toEqual([
      "completion",
      "independence",
      "momentum",
    ]);
  });

  it("weights the checklist by the spec's own weights", () => {
    const checklist = [...passed(1, 3), ...failed(1, 1)];
    const completion = autonomy(checklist, day(2, 0)).components.find((c) => c.id === "completion");
    expect(completion?.value).toBe(0.75);
    expect(completion?.detail).toContain("1/2 criteria passed");
  });

  it("gives completion nothing for criteria the run never decided", () => {
    // The do-nothing control again, but with its negative criteria as the checker
    // now reports them. Weight 9 apiece: if `notApplicable` reached the denominator
    // — or worse, the numerator — this would not be zero.
    const checklist = [...failed(1), ...unverifiable(3, 9)];
    const result = autonomy(checklist, day(0, 5));
    const completion = result.components.find((c) => c.id === "completion");

    expect(completion?.value).toBe(0);
    expect(completion?.detail).toContain("0/1 criteria passed");
    expect(completion?.detail).toContain("3 not applicable");
    expect(result.score).toBe(0);
  });

  it("scores an empty run at zero rather than dividing by zero", () => {
    const result = autonomy([], []);
    expect(result.score).toBe(0);
    expect(result.components).toEqual([
      expect.objectContaining({ id: "completion", value: 0, weight: 1 }),
    ]);
  });

  it("carries the verdict the score is qualified by, not just the score", () => {
    // The run that forced this: three `must`s nothing could decide and one `should`
    // that passed. Every component is perfect on what it could see, so the headline
    // is 100% — and 100% of one of four criteria is not a measurement of the day.
    const checklist: CriterionResult[] = [
      ...unverifiable(3).map((c) => ({ ...c, severity: "must" as const })),
      { ...passed(1)[0], severity: "should" as const },
    ];
    const result = autonomy(checklist, day(4, 0));

    expect(result.score).toBe(1);
    expect(result.outcome).toBe("inconclusive");
    expect(result.coverage).toMatchObject({ decided: 1, total: 4, undecidedMusts: 3 });
    const completion = result.components.find((c) => c.id === "completion");
    expect(completion?.detail).toContain("3 must-do(s) undecided");
  });

  it("leaves a fully decided run's verdict alone", () => {
    const result = autonomy(passed(3), day(4, 0));
    expect(result.score).toBe(1);
    expect(result.outcome).toBe("pass");
    expect(result.coverage).toMatchObject({ decided: 3, total: 3, undecidedMusts: 0 });
    expect(result.components.find((c) => c.id === "completion")?.detail).not.toContain("must-do");
  });

  it("gives every component a detail line the UI can open", () => {
    for (const c of autonomy(passed(1), day(2, 0)).components) {
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(1);
    }
  });
});
