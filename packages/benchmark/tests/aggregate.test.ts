import { describe, expect, it } from "vitest";
import { aggregate, summarizeRun, type CellResult } from "../src/aggregate";
import { planMatrix, type Cell } from "../src/plan";
import { cost, episodeRun, MATRIX } from "./fixtures";

// The table is the claim. If regenerating these numbers from the saved artifacts
// gave a different answer there would be nothing to publish, so every test here
// pins an arithmetic result rather than a shape.

const CELLS = planMatrix(MATRIX).cells;

function cellFor(scenarioId: string, model: string, seed: number): Cell {
  const c = CELLS.find((x) => x.scenarioId === scenarioId && x.model === model && x.seed === seed);
  if (!c) throw new Error(`no such cell: ${scenarioId}/${model}/${seed}`);
  return c;
}

function result(over: Partial<CellResult> & Pick<CellResult, "scenarioId" | "model" | "seed">): CellResult {
  return {
    runId: `${over.scenarioId}-${over.model}-${over.seed}`,
    status: "done",
    score: 0.8,
    autonomy: 0.8,
    outcome: "pass",
    cost: cost(),
    ticks: 3,
    durationMs: 60_000,
    failureModes: [],
    ...over,
  };
}

describe("summarizeRun", () => {
  it("flattens a finished episode onto its cell", () => {
    const cell = cellFor("sla-escalation", "openai/gpt-5-mini", 1);
    const r = summarizeRun(cell, episodeRun({ score: 0.75, autonomy: 0.6, outcome: "partial" }));

    expect(r).toMatchObject({
      scenarioId: "sla-escalation",
      model: "openai/gpt-5-mini",
      seed: 1,
      status: "done",
      score: 0.75,
      autonomy: 0.6,
      outcome: "partial",
      ticks: 3,
    });
    expect(r.durationMs).toBe(60_000);
  });

  it("dedupes and sorts the judge's findings into per-run modes", () => {
    const cell = cellFor("sla-escalation", "openai/gpt-5-mini", 1);
    const r = summarizeRun(cell, episodeRun({ modes: ["over-escalated", "bulk-swept", "over-escalated"] }));
    // Counted per run, not per finding — so a chatty judge cannot inflate a rate.
    expect(r.failureModes).toEqual(["bulk-swept", "over-escalated"]);
  });

  it("scores an unjudged run zero rather than dropping it", () => {
    const cell = cellFor("sla-escalation", "openai/gpt-5-mini", 1);
    const r = summarizeRun(cell, episodeRun({ noVerdict: true, status: "failed", error: "boom" }));

    expect(r).toMatchObject({ status: "failed", score: 0, autonomy: 0, outcome: "fail", error: "boom" });
    // Excluding it would flatter exactly the models that fell over.
    expect(r.cost.usd).toBe(0);
  });

  it("takes the override cost only when there is no verdict to read it from", () => {
    const cell = cellFor("sla-escalation", "openai/gpt-5-mini", 1);
    const override = cost({ usd: 9 });

    expect(summarizeRun(cell, episodeRun({ usd: 0.25 }), { cost: override }).cost.usd).toBe(0.25);
    expect(summarizeRun(cell, episodeRun({ noVerdict: true }), { cost: override }).cost.usd).toBe(9);
  });
});

describe("aggregate", () => {
  it("means autonomy across seeds and reports the spread we observed", () => {
    const rows = [
      result({ scenarioId: "sla-escalation", model: "m1", seed: 1, autonomy: 0.6 }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, autonomy: 1.0 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"] }, rows);
    const s = agg.byModel[0].byScenario["sla-escalation"];

    expect(s.meanAutonomy).toBeCloseTo(0.8, 12);
    // Population variance: ((0.8-0.6)^2 + (1.0-0.8)^2) / 2 = 0.04.
    expect(s.autonomyVariance).toBeCloseTo(0.04, 12);
    expect(s.autonomyStdDev).toBeCloseTo(0.2, 12);
  });

  it("reports zero variance for a single seed rather than dividing by n-1", () => {
    const rows = [result({ scenarioId: "sla-escalation", model: "m1", seed: 1, autonomy: 0.6 })];
    const agg = aggregate({ ...MATRIX, models: ["m1"], seeds: [1] }, rows);
    expect(agg.byModel[0].byScenario["sla-escalation"].autonomyVariance).toBe(0);
    // A one-seed scenario contributes nothing to the reproducibility figure.
    expect(agg.byModel[0].seedVariance).toBe(0);
  });

  it("means the per-scenario variances into one reproducibility figure", () => {
    const rows = [
      result({ scenarioId: "sla-escalation", model: "m1", seed: 1, autonomy: 0.6 }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, autonomy: 1.0 }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 1, autonomy: 0.5 }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 2, autonomy: 0.5 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"] }, rows);
    // (0.04 + 0) / 2.
    expect(agg.byModel[0].seedVariance).toBeCloseTo(0.02, 12);
    expect(agg.byModel[0].meanAutonomy).toBeCloseTo(0.65, 12);
  });

  it("counts task success as the share of episodes that fully passed", () => {
    const rows = [
      result({ scenarioId: "sla-escalation", model: "m1", seed: 1, outcome: "pass" }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, outcome: "partial" }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 1, outcome: "fail" }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 2, outcome: "pass" }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"] }, rows);
    expect(agg.byModel[0].successRate).toBe(0.5);
    expect(agg.byModel[0].byScenario["sla-escalation"].successRate).toBe(0.5);
    expect(agg.byModel[0].byScenario["quiet-monday"].successRate).toBe(0.5);
  });

  it("counts a failure mode once per run and rates it over the model's episodes", () => {
    const rows = [
      result({
        scenarioId: "sla-escalation",
        model: "m1",
        seed: 1,
        failureModes: ["over-escalated", "bulk-swept"],
      }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, failureModes: ["over-escalated"] }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 1, failureModes: ["over-escalated"] }),
      result({ scenarioId: "quiet-monday", model: "m1", seed: 2, failureModes: [] }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"] }, rows);
    expect(agg.byModel[0].failureModes).toEqual([
      { mode: "over-escalated", runs: 3, rate: 0.75 },
      { mode: "bulk-swept", runs: 1, rate: 0.25 },
    ]);
  });

  it("means cost per episode and totals spend across the matrix", () => {
    const rows = [
      result({ scenarioId: "sla-escalation", model: "m1", seed: 1, cost: cost({ usd: 0.2 }) }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, cost: cost({ usd: 0.4 }) }),
      result({ scenarioId: "quiet-monday", model: "m2", seed: 1, cost: cost({ usd: 1 }) }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1", "m2"] }, rows);
    const m1 = agg.byModel.find((m) => m.model === "m1");
    expect(m1?.meanCostUsd).toBeCloseTo(0.3, 12);
    expect(m1?.totalCostUsd).toBeCloseTo(0.6, 12);
    expect(agg.totalCostUsd).toBeCloseTo(1.6, 12);
  });

  it("orders rows best-first and keeps the matrix's column order", () => {
    const rows = [
      result({ scenarioId: "quiet-monday", model: "m1", seed: 1, autonomy: 0.2 }),
      result({ scenarioId: "quiet-monday", model: "m2", seed: 1, autonomy: 0.9 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1", "m2"], seeds: [1] }, rows);
    expect(agg.byModel.map((m) => m.model)).toEqual(["m2", "m1"]);
    expect(agg.scenarioIds).toEqual(["sla-escalation", "quiet-monday"]);
  });

  it("breaks ties on mean autonomy alphabetically, so the order is stable", () => {
    const rows = [
      result({ scenarioId: "quiet-monday", model: "zeta", seed: 1, autonomy: 0.5 }),
      result({ scenarioId: "quiet-monday", model: "alpha", seed: 1, autonomy: 0.5 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["zeta", "alpha"], seeds: [1] }, rows);
    expect(agg.byModel.map((m) => m.model)).toEqual(["alpha", "zeta"]);
  });

  it("leaves a scenario a model never ran out of its row entirely", () => {
    const rows = [result({ scenarioId: "sla-escalation", model: "m1", seed: 1 })];
    const agg = aggregate({ ...MATRIX, models: ["m1"], seeds: [1] }, rows);
    // Not run and scored zero must not look the same.
    expect(Object.keys(agg.byModel[0].byScenario)).toEqual(["sla-escalation"]);
  });

  it("drops a model with no episodes but keeps its column order for scenarios", () => {
    const rows = [result({ scenarioId: "sla-escalation", model: "m1", seed: 1 })];
    const agg = aggregate({ ...MATRIX, models: ["m1", "never-ran"] }, rows);
    expect(agg.byModel.map((m) => m.model)).toEqual(["m1"]);
  });

  it("still aggregates results from outside the matrix, so a widened matrix keeps its history", () => {
    const rows = [
      result({ scenarioId: "sla-escalation", model: "m1", seed: 1 }),
      result({ scenarioId: "retired-scenario", model: "old-model", seed: 1 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"], seeds: [1] }, rows);
    expect(agg.byModel.map((m) => m.model).sort()).toEqual(["m1", "old-model"]);
    expect(agg.scenarioIds).toContain("retired-scenario");
  });

  it("counts crashed episodes without hiding them from the totals", () => {
    const rows = [
      result({
        scenarioId: "sla-escalation",
        model: "m1",
        seed: 1,
        status: "failed",
        autonomy: 0,
        outcome: "fail",
        cost: cost({ usd: 0 }),
      }),
      result({ scenarioId: "sla-escalation", model: "m1", seed: 2, autonomy: 1 }),
    ];
    const agg = aggregate({ ...MATRIX, models: ["m1"] }, rows);
    expect(agg.failed).toBe(1);
    expect(agg.episodes).toBe(2);
    expect(agg.byModel[0].failed).toBe(1);
    // The crash drags the mean down; that is the honest number.
    expect(agg.byModel[0].meanAutonomy).toBe(0.5);
  });

  it("is a pure function of its inputs", () => {
    const rows = [result({ scenarioId: "sla-escalation", model: "m1", seed: 1 })];
    expect(aggregate(MATRIX, rows)).toEqual(aggregate(MATRIX, rows));
    expect(aggregate(MATRIX, [])).toMatchObject({ episodes: 0, byModel: [], totalCostUsd: 0 });
  });
});
