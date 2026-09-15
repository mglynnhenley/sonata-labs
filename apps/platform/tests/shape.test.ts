import { describe, expect, it } from "vitest";
import type { AgentStep, CriterionResult, EpisodeRun, EpisodeSpec, TickRecord, TwinName } from "@sonata/core";
import { dayShape } from "../app/results/_lib/shape";

// THE READING THAT STARTED THIS.
//
// `run_mu1mbyqx_khy6` scored 0%, and its judge's account opened with five
// sentences beginning "Never sent", "Never prepared", "Never updated". It reads
// as an agent that did nothing. The day had stopped at tick 3 of 4, before any
// of that could have arrived.
//
// So the one thing this must never do is let a day we cut short read as a
// failure the agent chose — and, equally, must never hand that excuse to an
// agent that had its whole day and sat on it.

const step = (seq: number, isMutation: boolean, twin: TwinName = "excel"): AgentStep => ({
  kind: "tool", seq, at: 1000 + seq, twin, name: "update_cells", args: {}, resultSummary: "ok", isMutation,
});

function tick(n: number, steps: AgentStep[] = []): TickRecord {
  return {
    tick: n, simTimeISO: `2026-09-17T0${9 + n}:00:00Z`, startedAt: 1000 + n, endedAt: 1100 + n,
    beatsFired: [], directorEvents: [], agentSteps: steps, notes: [],
  };
}

const criterion = (status: CriterionResult["status"]): CriterionResult => ({
  id: `c-${status}-${Math.random()}`, description: "something domain-specific", twin: "excel",
  kind: "judged", severity: "must", weight: 1, status,
});

function run(over: Partial<EpisodeRun> = {}): EpisodeRun {
  return {
    runId: "run_fixture", specId: "day", specTitle: "A day", model: "fixture/model",
    status: "done", startedAt: 1000, endedAt: 9000,
    ticks: [tick(0, [step(0, true)]), tick(1), tick(2), tick(3)],
    snapshots: {}, verdict: null, ...over,
  };
}

const spec = (ticks: number): EpisodeSpec => ({
  id: "day", title: "A day", task: "t", story: "s",
  clock: { startISO: "2026-09-17T09:00:00Z", ticks, simMinutesPerTick: 15 },
  world: { business: { name: "N", description: "d", industry: "i", size: 2 }, cast: [], channels: [], mailboxOwner: "a" },
  beats: [], director: { maxEventsPerTick: 1, personas: [], offLimits: [], style: "s" },
  success: { checklist: [], judgeQuestions: [] },
  termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 0 },
});

describe("what kind of day this was", () => {
  it("blames the day, not the agent, when the day was cut short", () => {
    // Four intervals recorded, thirty-six planned: the exact shape of the run
    // whose report read as an agent that never did anything.
    const shape = dayShape(run(), spec(36));
    expect(shape.cause).toBe("harness");
    expect(shape.headline).toContain("stopped after 4 of 36 intervals");
    expect(shape.headline).toContain("may simply never have arrived");
    expect(shape.facts.find((f) => f.label === "How far it got")).toMatchObject({ value: "4 of 36 intervals", flag: true });
  });

  it("refuses that excuse to an agent that had the whole day and touched nothing", () => {
    const idle = dayShape(run({ ticks: [tick(0), tick(1), tick(2), tick(3)] }), spec(4));
    expect(idle.cause).toBe("agent");
    expect(idle.headline).toContain("used none of them");
    expect(idle.headline).toContain("Nothing here was cut short on our side");
    // The exculpatory sentence must not appear anywhere in it.
    expect(idle.headline).not.toContain("not available to it");
  });

  it("separates requirements that could not be judged from requirements it failed", () => {
    // Twelve rows, none gradeable: a 0% that means "nothing was measurable",
    // which is the number most likely to be read as "got everything wrong".
    const shape = dayShape(
      run({ verdict: { outcome: "inconclusive", score: 0, autonomy: 0, judge: null,
        checklist: Array.from({ length: 12 }, () => criterion("notApplicable")),
        cost: { usd: 0, llmCalls: 0, promptTokens: 0, completionTokens: 0 } } }),
      spec(4),
    );
    expect(shape.facts.find((f) => f.label === "Requirements that could be judged"))
      .toMatchObject({ value: "0 of 12", flag: true });
    expect(shape.headline).toContain("nothing on the scorecard could be measured");
  });

  it("counts a continuity week in its own marks, and calls none of them zero", () => {
    const shape = dayShape(
      run({ benchmark: {
        kind: "continuity", version: 1, caseId: "E01", completion: "partial",
        completedTicks: 4, plannedTicks: 180, completedThrough: null,
        incidents: [], limitations: [], snapshots: { before: "", after: "" },
        families: [], coverage: { totalUnits: 2, measuredUnits: 1, unmeasuredUnits: 1 },
        criteria: [{ id: "EO01", family: "preparation", units: [
          { id: "u1", score: "U", evidence: [], reason: "not reached" },
          { id: "u2", score: 2, evidence: [], reason: "done" },
        ] }],
      } as unknown as EpisodeRun["benchmark"] }),
      spec(180),
    );
    expect(shape.facts.find((f) => f.label === "Marks the week could give")).toMatchObject({ value: "1 of 2" });
    // The checklist wording must not appear for a week that has its own marks.
    expect(shape.facts.some((f) => f.label === "Requirements that could be judged")).toBe(false);
  });

  it("says plainly when a finished day left the world untouched", () => {
    const shape = dayShape(run({ ticks: [tick(0, [step(0, false)]), tick(1), tick(2), tick(3)] }), spec(4));
    expect(shape.headline).toContain("changed nothing in any app");
    expect(shape.facts.find((f) => f.label === "What it changed")).toMatchObject({ value: "nothing", flag: true });
  });

  it("will not call a day complete when nothing told it how long the day was", () => {
    // The exported report used to build this without a spec, so a four-interval
    // smoke of a thirty-six-interval day read as a day that ran to the end —
    // while the page beside it said the day had been cut short.
    const blind = dayShape(run());
    expect(blind.facts.find((f) => f.label === "How far it got")?.value).toBe("4 intervals recorded");
    expect(blind.headline).not.toContain("ran to the end");
    expect(blind.cause).not.toBe("harness");
  });

  it("names the surfaces it touched, so a reader knows where to look", () => {
    const shape = dayShape(
      run({ ticks: [tick(0, [step(0, true, "excel"), step(1, true, "gmail"), step(2, true, "slack")]), tick(1), tick(2), tick(3)] }),
      spec(4),
    );
    expect(shape.facts.find((f) => f.label === "What it changed")?.value).toBe("3 changes, in Excel, Gmail and Slack");
  });
});
