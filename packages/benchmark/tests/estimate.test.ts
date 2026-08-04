import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLES,
  estimateCell,
  estimatePlan,
  estimateRole,
  formatDuration,
  formatEstimate,
  formatUsd,
  MODEL_PRICES,
  type ModelPrice,
  type RoleProfile,
} from "../src/estimate";
import { planMatrix, type Cell } from "../src/plan";
import { MATRIX } from "./fixtures";

// The dry-run's whole job is to answer "forty dollars or four hundred?" before
// anyone spends either. So the arithmetic is checked against figures worked out
// by hand rather than against itself.

const PRICES: Record<string, ModelPrice> = {
  cheap: { inputPerMTok: 1, outputPerMTok: 5 },
  dear: { inputPerMTok: 10, outputPerMTok: 50 },
};

const AGENT: RoleProfile = {
  role: "agent",
  callsPerTick: 2,
  callsPerEpisode: 0,
  promptTokens: 1000,
  promptGrowthPerTick: 100,
  completionTokens: 50,
  secondsPerCall: 10,
};

const JUDGE: RoleProfile = {
  role: "judge",
  callsPerTick: 0,
  callsPerEpisode: 1,
  promptTokens: 6000,
  promptGrowthPerTick: 700,
  completionTokens: 1500,
  secondsPerCall: 30,
};

const CELL: Cell = {
  runId: "b--s--m--s0",
  scenarioId: "sla-escalation",
  model: "cheap",
  seed: 0,
  index: 0,
};

describe("estimateRole", () => {
  it("prices per-tick calls against the context as it stood on their tick", () => {
    // 4 ticks x 2 calls. Prompt = 2 * (4*1000 + 100 * (4*3/2)) = 2 * 4600 = 9200.
    const e = estimateRole(AGENT, 4, "cheap", PRICES);
    expect(e.calls).toBe(8);
    expect(e.promptTokens).toBe(9200);
    expect(e.completionTokens).toBe(400);
    expect(e.usd).toBeCloseTo((9200 * 1 + 400 * 5) / 1_000_000, 12);
    expect(e.seconds).toBe(80);
    expect(e.priced).toBe(true);
  });

  it("grows superlinearly with the day, which is the whole warning", () => {
    const short = estimateRole(AGENT, 4, "cheap", PRICES);
    const long = estimateRole(AGENT, 8, "cheap", PRICES);
    expect(long.calls).toBe(short.calls * 2);
    // Twice the ticks, more than twice the prompt tokens: the context grows too.
    expect(long.promptTokens).toBeGreaterThan(short.promptTokens * 2);
    expect(long.promptTokens).toBe(2 * (8 * 1000 + 100 * ((8 * 7) / 2)));
  });

  it("prices a per-episode call against the end-of-day context", () => {
    // One call, prompt = 6000 + 700*4.
    const e = estimateRole(JUDGE, 4, "cheap", PRICES);
    expect(e.calls).toBe(1);
    expect(e.promptTokens).toBe(8800);
    expect(e.completionTokens).toBe(1500);
    expect(e.seconds).toBe(30);
  });

  it("charges nothing for a zero-tick day", () => {
    const e = estimateRole(AGENT, 0, "cheap", PRICES);
    expect(e).toMatchObject({ calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, seconds: 0 });
  });

  it("reports an unpriced model instead of guessing a number", () => {
    const e = estimateRole(AGENT, 4, "no-such-model", PRICES);
    expect(e.priced).toBe(false);
    expect(e.usd).toBe(0);
    // Token counts are still real — only the money is unknown.
    expect(e.promptTokens).toBe(9200);
  });
});

describe("estimateCell", () => {
  it("runs the agent on the cell's model and everything else on the harness model", () => {
    const e = estimateCell(CELL, {
      roles: [AGENT, JUDGE],
      prices: PRICES,
      harnessModel: "dear",
      ticksPerEpisode: 4,
    });

    expect(e.roles.map((r) => [r.role, r.model])).toEqual([
      ["agent", "cheap"],
      ["judge", "dear"],
    ]);
    expect(e.calls).toBe(9);
    expect(e.promptTokens).toBe(9200 + 8800);
    expect(e.completionTokens).toBe(400 + 1500);
    expect(e.seconds).toBe(80 + 30);
    expect(e.usd).toBeCloseTo(
      (9200 * 1 + 400 * 5) / 1_000_000 + (8800 * 10 + 1500 * 50) / 1_000_000,
      12,
    );
  });

  it("takes the tick count per scenario, falling back to the flat default", () => {
    const opts = {
      roles: [AGENT],
      prices: PRICES,
      ticksByScenario: { "sla-escalation": 8 },
      ticksPerEpisode: 4,
    };
    expect(estimateCell(CELL, opts).ticks).toBe(8);
    expect(estimateCell({ ...CELL, scenarioId: "quiet-monday" }, opts).ticks).toBe(4);
  });

  it("ships defaults that price a real day without any options", () => {
    const e = estimateCell({ ...CELL, model: "anthropic/claude-haiku-4.5" });
    expect(e.ticks).toBe(32);
    expect(e.usd).toBeGreaterThan(0);
    expect(e.roles.every((r) => r.priced)).toBe(true);
    expect(DEFAULT_ROLES.map((r) => r.role)).toEqual(["agent", "director", "judge"]);
  });
});

describe("estimatePlan", () => {
  const opts = { roles: [AGENT], prices: PRICES, harnessModel: "dear", ticksPerEpisode: 4 };
  const matrix = { ...MATRIX, models: ["cheap", "dear"] };

  it("prices what is left to run, not what has already been paid for", () => {
    const full = planMatrix(matrix);
    const resumed = planMatrix(matrix, full.cells.slice(0, 6).map((c) => c.runId));

    const a = estimatePlan(full, opts);
    const b = estimatePlan(resumed, opts);

    expect(a.cells).toHaveLength(8);
    expect(b.cells).toHaveLength(2);
    expect(b.usd).toBeCloseTo(a.usd / 4, 12);
  });

  it("sums duration rather than maxing it, because cells run one at a time", () => {
    const est = estimatePlan(planMatrix(matrix), opts);
    expect(est.seconds).toBe(8 * 80);
  });

  it("breaks spend down by model, dearest first", () => {
    const est = estimatePlan(planMatrix(matrix), opts);
    expect(est.byModel.map((m) => m.model)).toEqual(["dear", "cheap"]);
    expect(est.byModel.map((m) => m.cells)).toEqual([4, 4]);
    expect(est.byModel[0].usd).toBeCloseTo(est.byModel[1].usd * 10, 12);
    expect(est.usd).toBeCloseTo(est.byModel[0].usd + est.byModel[1].usd, 12);
  });

  it("names unpriced models so the total is not read as complete", () => {
    const est = estimatePlan(planMatrix({ ...matrix, models: ["cheap", "mystery"] }), opts);
    expect(est.unpriced).toEqual(["mystery"]);
    expect(formatEstimate(est)).toContain("NO PRICE for mystery");
  });

  it("has a price row for every model it ships a default for", () => {
    for (const model of Object.keys(MODEL_PRICES)) {
      expect(MODEL_PRICES[model].inputPerMTok).toBeGreaterThan(0);
      expect(MODEL_PRICES[model].outputPerMTok).toBeGreaterThan(0);
    }
  });
});

describe("formatting", () => {
  it("writes durations a person can act on", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(570)).toBe("9m 30s");
    expect(formatDuration(8040)).toBe("2h 14m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("keeps the leading digits of small spends", () => {
    expect(formatUsd(0.0412)).toBe("$0.0412");
    expect(formatUsd(41.234)).toBe("$41.23");
    expect(formatUsd(0)).toBe("$0.0000");
  });
});
