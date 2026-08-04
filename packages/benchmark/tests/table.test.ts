import { describe, expect, it } from "vitest";
import { aggregate, type BenchmarkAggregate, type CellResult } from "../src/aggregate";
import type { BenchmarkMatrix } from "../src/plan";
import {
  formatPct,
  formatScore,
  renderFailureModeTable,
  renderMatrixTable,
  renderReport,
  renderSummaryTable,
  type TableOptions,
} from "../src/table";
import { cost } from "./fixtures";

// The rendered string IS the artifact — it gets pasted into the article. So these
// tests pin it character for character rather than checking that it "contains"
// things: a column that loses its padding, or a mean that gains a decimal, is a
// change to something published.

const HAIKU = "anthropic/claude-haiku-4.5";
const GPT = "openai/gpt-5-mini";

const MATRIX: BenchmarkMatrix = {
  id: "workday-v1",
  scenarioIds: ["sla-escalation", "quiet-monday"],
  models: [HAIKU, GPT],
  seeds: [1, 2],
};

const LABELS: TableOptions = {
  scenarioLabels: { "sla-escalation": "SLA escalation", "quiet-monday": "Quiet Monday" },
  modelLabels: { [HAIKU]: "Haiku 4.5", [GPT]: "GPT-5 mini" },
};

function row(
  model: string,
  scenarioId: string,
  seed: number,
  autonomy: number,
  outcome: CellResult["outcome"],
  usd: number,
  failureModes: string[] = [],
): CellResult {
  return {
    runId: `workday-v1--${scenarioId}--${model}--s${seed}`,
    scenarioId,
    model,
    seed,
    status: "done",
    score: autonomy,
    autonomy,
    outcome,
    cost: cost({ usd }),
    ticks: 32,
    durationMs: 300_000,
    failureModes,
  };
}

const RESULTS: CellResult[] = [
  row(HAIKU, "sla-escalation", 1, 0.6, "partial", 0.12, ["over-escalated"]),
  row(HAIKU, "sla-escalation", 2, 0.8, "pass", 0.14),
  row(HAIKU, "quiet-monday", 1, 0.9, "pass", 0.1),
  row(HAIKU, "quiet-monday", 2, 0.9, "pass", 0.1, ["tone-mismatch"]),
  row(GPT, "sla-escalation", 1, 0.4, "fail", 0.3, ["over-escalated", "stalled"]),
  row(GPT, "sla-escalation", 2, 0.5, "partial", 0.32, ["over-escalated"]),
  row(GPT, "quiet-monday", 1, 0.7, "pass", 0.28),
  row(GPT, "quiet-monday", 2, 0.7, "pass", 0.28),
];

const AGG: BenchmarkAggregate = aggregate(MATRIX, RESULTS);

describe("renderMatrixTable", () => {
  it("renders models x scenarios with autonomy and its across-seed spread", () => {
    expect(renderMatrixTable(AGG, LABELS)).toBe(
      [
        "| Model      | SLA escalation | Quiet Monday | Mean |",
        "| :--------- | -------------: | -----------: | ---: |",
        "| Haiku 4.5  |     0.70 ±0.10 |   0.90 ±0.00 | 0.80 |",
        "| GPT-5 mini |     0.45 ±0.05 |   0.70 ±0.00 | 0.57 |",
      ].join("\n"),
    );
  });

  it("falls back to raw ids when nothing is labelled", () => {
    expect(renderMatrixTable(AGG).split("\n")[0]).toBe(
      "| Model                      | sla-escalation | quiet-monday | Mean |",
    );
  });

  it("drops the spread on request", () => {
    expect(renderMatrixTable(AGG, { ...LABELS, spread: false })).toBe(
      [
        "| Model      | SLA escalation | Quiet Monday | Mean |",
        "| :--------- | -------------: | -----------: | ---: |",
        "| Haiku 4.5  |           0.70 |         0.90 | 0.80 |",
        "| GPT-5 mini |           0.45 |         0.70 | 0.57 |",
      ].join("\n"),
    );
  });

  it("shows no spread on a single seed, which would claim untested reproducibility", () => {
    const single = aggregate({ ...MATRIX, models: [HAIKU], seeds: [1] }, [
      row(HAIKU, "sla-escalation", 1, 0.6, "partial", 0.12),
      row(HAIKU, "quiet-monday", 1, 0.9, "pass", 0.1),
    ]);
    expect(renderMatrixTable(single, LABELS)).toBe(
      [
        "| Model     | SLA escalation | Quiet Monday | Mean |",
        "| :-------- | -------------: | -----------: | ---: |",
        "| Haiku 4.5 |           0.60 |         0.90 | 0.75 |",
      ].join("\n"),
    );
  });

  it("marks a scenario a model never ran, rather than printing 0.00", () => {
    const partial = aggregate(MATRIX, [
      row(HAIKU, "sla-escalation", 1, 0.6, "partial", 0.12),
      row(GPT, "quiet-monday", 1, 0.9, "pass", 0.1),
    ]);
    expect(renderMatrixTable(partial, LABELS)).toBe(
      [
        "| Model      | SLA escalation | Quiet Monday | Mean |",
        "| :--------- | -------------: | -----------: | ---: |",
        "| GPT-5 mini |              — |         0.90 | 0.90 |",
        "| Haiku 4.5  |           0.60 |            — | 0.60 |",
      ].join("\n"),
    );
    expect(renderMatrixTable(partial, { ...LABELS, missing: "n/a" })).toContain("n/a");
  });

  it("escapes a pipe in a label, which would otherwise end the column early", () => {
    const line = renderMatrixTable(AGG, {
      ...LABELS,
      modelLabels: { ...LABELS.modelLabels, [HAIKU]: "a|b" },
    }).split("\n")[2];
    expect(line.startsWith("| a\\|b ")).toBe(true);
  });
});

describe("renderSummaryTable", () => {
  it("puts cost per episode next to autonomy, where the argument actually is", () => {
    expect(renderSummaryTable(AGG, LABELS)).toBe(
      [
        "| Model      | Episodes | Autonomy | Task success | Cost/episode | Seed variance | Failed | Top failure mode   |",
        "| :--------- | -------: | -------: | -----------: | -----------: | ------------: | -----: | :----------------- |",
        "| Haiku 4.5  |        4 |     0.80 |          75% |      $0.1150 |        0.0050 |      0 | Over-escalated (1) |",
        "| GPT-5 mini |        4 |     0.57 |          50% |      $0.2950 |        0.0012 |      0 | Over-escalated (2) |",
      ].join("\n"),
    );
  });

  it("shows a dash where a model produced no catalogued findings", () => {
    const clean = aggregate({ ...MATRIX, models: [HAIKU], seeds: [1] }, [
      row(HAIKU, "sla-escalation", 1, 1, "pass", 0.1),
    ]);
    expect(renderSummaryTable(clean, LABELS).split("\n")[2]).toMatch(/\|\s+0\s\|\s—\s+\|$/);
  });
});

describe("renderFailureModeTable", () => {
  it("counts runs per mode per model, most frequent first, with catalog labels", () => {
    expect(renderFailureModeTable(AGG, LABELS)).toBe(
      [
        "| Failure mode   | Haiku 4.5 | GPT-5 mini |",
        "| :------------- | --------: | ---------: |",
        "| Over-escalated |   1 (25%) |    2 (50%) |",
        "| Stalled        |         · |    1 (25%) |",
        "| Tone mismatch  |   1 (25%) |          · |",
      ].join("\n"),
    );
  });

  it("falls back to the raw id for a mode outside the catalog", () => {
    const odd = aggregate({ ...MATRIX, models: [HAIKU], seeds: [1] }, [
      row(HAIKU, "sla-escalation", 1, 0.5, "partial", 0.1, ["invented-by-the-judge"]),
    ]);
    expect(renderFailureModeTable(odd, LABELS)).toContain("invented-by-the-judge");
  });

  it("says so plainly when nothing was found, rather than printing a wall of zeroes", () => {
    const clean = aggregate({ ...MATRIX, models: [HAIKU], seeds: [1] }, [
      row(HAIKU, "sla-escalation", 1, 1, "pass", 0.1),
    ]);
    expect(renderFailureModeTable(clean, LABELS)).toBe(
      "_No catalogued failure modes were found._",
    );
  });
});

describe("renderReport", () => {
  it("renders the exact block that goes into the article", () => {
    expect(renderReport(AGG, LABELS)).toBe(
      [
        "## workday-v1",
        "",
        "### Autonomy by scenario",
        "",
        "| Model      | SLA escalation | Quiet Monday | Mean |",
        "| :--------- | -------------: | -----------: | ---: |",
        "| Haiku 4.5  |     0.70 ±0.10 |   0.90 ±0.00 | 0.80 |",
        "| GPT-5 mini |     0.45 ±0.05 |   0.70 ±0.00 | 0.57 |",
        "",
        "### Summary",
        "",
        "| Model      | Episodes | Autonomy | Task success | Cost/episode | Seed variance | Failed | Top failure mode   |",
        "| :--------- | -------: | -------: | -----------: | -----------: | ------------: | -----: | :----------------- |",
        "| Haiku 4.5  |        4 |     0.80 |          75% |      $0.1150 |        0.0050 |      0 | Over-escalated (1) |",
        "| GPT-5 mini |        4 |     0.57 |          50% |      $0.2950 |        0.0012 |      0 | Over-escalated (2) |",
        "",
        "### Failure modes",
        "",
        "| Failure mode   | Haiku 4.5 | GPT-5 mini |",
        "| :------------- | --------: | ---------: |",
        "| Over-escalated |   1 (25%) |    2 (50%) |",
        "| Stalled        |         · |    1 (25%) |",
        "| Tone mismatch  |   1 (25%) |          · |",
        "",
        "_8 episodes — 2 model(s) x 2 scenario(s) x 2 seed(s). Total spend $1.64._",
        "",
      ].join("\n"),
    );
  });

  it("owns up to crashed episodes in the provenance line", () => {
    const broken = aggregate({ ...MATRIX, models: [HAIKU], seeds: [1] }, [
      { ...row(HAIKU, "sla-escalation", 1, 0, "fail", 0), status: "failed", error: "502" },
      row(HAIKU, "quiet-monday", 1, 0.9, "pass", 0.1),
    ]);
    expect(renderReport(broken, LABELS)).toContain("_2 episodes, 1 of them failed to complete —");
  });

  it("is a pure function of the aggregate", () => {
    expect(renderReport(AGG, LABELS)).toBe(renderReport(AGG, LABELS));
  });
});

describe("formatScore / formatPct", () => {
  it("keeps two decimals, where the seed noise lives", () => {
    expect(formatScore(0.575)).toBe("0.57");
    expect(formatScore(1)).toBe("1.00");
  });

  it("rounds percentages to whole numbers", () => {
    expect(formatPct(0.5)).toBe("50%");
    expect(formatPct(2 / 3)).toBe("67%");
  });
});
