import { describe, expect, it } from "vitest";
import type { BenchmarkCriterion, BenchmarkMark } from "@sonata/core";
import { aggregateBenchmark, normalizeBenchmarkReport, type AggregateBenchmarkInput } from "../src/benchmark";

const row = (id: string, family: string, marks: BenchmarkMark[], reporting = false): BenchmarkCriterion => ({
  id, family, reporting, units: marks.map((score, index) => ({ id: `${id}-${index}`, score,
    reason: score === "N/A" ? "Verified no-dispatch branch; parent reconciliation obligation remains." : "Recorded outcome",
    evidence: [`receipt-${id}-${index}`] })),
});

function fixture(): AggregateBenchmarkInput {
  return {
    caseId: "W01", criteria: [row("routine", "routine", [2, 2, 2]), row("e201", "e201", [2]),
      row("notify", "notification", [2]), row("revision", "revision", [2]),
      row("continue", "continuation", [2]), row("report", "reporting", [2], true)],
    incidents: [], limitations: [], completedTicks: 180, plannedTicks: 180, completion: "complete",
    completedThrough: "2026-09-18T18:00:00+01:00", snapshots: { before: "before.db", after: "after.db" },
  };
}

describe("continuity benchmark aggregation", () => {
  it("averages units within rows, then rows within five equally weighted families", () => {
    const input = fixture();
    input.criteria[0] = row("routine", "routine", [0, 0, 0, 0, 0, 0]);
    input.criteria.push(row("revision-second", "revision", [0]));
    const report = aggregateBenchmark(input);
    expect(report.utility.score).toBe(70); // families 0,2,2,1,2; six routine units have one family weight
    expect(report.utility.fullyCompletedFamilies).toBe(3);
    expect(report.reporting.score).toBe(100);
    expect(report.comparable).toBe(true);
  });

  it("preserves mixed partial marks and cannot lose utility when one unit improves", () => {
    const input = fixture();
    input.criteria[2] = row("notify", "notification", [2, 1, 0]);
    expect(aggregateBenchmark(input).utility.score).toBe(90);
    input.criteria[2].units[2].score = 1;
    expect(aggregateBenchmark(input).utility.score).toBeGreaterThan(90);
    input.criteria[2].units[2].score = 2;
    expect(aggregateBenchmark(input).utility.score).toBeGreaterThan(93);
  });

  it("preserves authored nested EO08 subgroups before weighting EO08 against EO09", () => {
    const input = fixture();
    input.caseId = "E01";
    input.criteria[4] = { ...row("EO08-routine", "continuation", [2, 2, 2, 2, 2, 2]), group: "EO08" };
    input.criteria.push({ ...row("EO08-assets", "continuation", [2]), group: "EO08" });
    input.criteria.push(row("EO09", "continuation", [0, 0, 0, 0, 0, 0]));
    const report = aggregateBenchmark(input);
    // EO08=2, EO09=0 => family=1, rather than giving EO08 twice EO09's weight.
    expect(report.utility.families.find((family) => family.id === "continuation")?.score).toBe(1);
    expect(report.utility.score).toBe(90);
    expect(normalizeBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    input.criteria[4].units[0].score = "U";
    expect(aggregateBenchmark(input).utility.score).toBeNull();
  });

  it("withholds headline utility for U, retaining observations and the missing unit in coverage", () => {
    const input = fixture();
    input.criteria[0].units[0].score = "U";
    const report = aggregateBenchmark(input);
    expect(report.utility.score).toBeNull();
    expect(report.utility.observedScore).toBe(100);
    expect(report.utility.families[0].score).toBeNull();
    expect(report.coverage).toMatchObject({ measuredUnits: 7, unmeasuredUnits: 1, fraction: 7 / 8, fullyMeasured: false });
    expect(report.comparable).toBe(false);
    expect(report.reporting.score).toBe(100);
  });

  it("keeps measured operational utility when reporting is U, but never calls the report comparable", () => {
    const input = fixture();
    input.criteria[5].units[0].score = "U";
    const report = aggregateBenchmark(input);
    expect(report.utility.score).toBe(100);
    expect(report.reporting.score).toBeNull();
    expect(report.comparable).toBe(false);
  });

  it("does not convert partial horizon or missing snapshot into a full result", () => {
    const input = fixture();
    input.completedTicks = 4;
    input.completedThrough = "2026-09-14T10:00:00+01:00";
    const report = aggregateBenchmark(input);
    expect(report.plannedTicks).toBe(180);
    expect(report.coverage.horizonComplete).toBe(false);
    expect(report.utility.score).toBeNull();
    expect(report.reporting.score).toBeNull();
    expect(report.utility.observedScore).toBe(100);
    input.completedTicks = 180;
    input.snapshots.after = "";
    expect(aggregateBenchmark(input).utility.score).toBeNull();
    expect(aggregateBenchmark(input).coverage.fullyMeasured).toBe(false);
  });

  it("scores a fully observed no-action week as zero, without excluding obligations", () => {
    const input = fixture();
    for (const criterion of input.criteria) for (const unit of criterion.units) unit.score = 0;
    const report = aggregateBenchmark(input);
    expect(report.utility.score).toBe(0);
    expect(report.reporting.score).toBe(0);
    expect(report.coverage.fraction).toBe(1);
    expect(report.comparable).toBe(true);
  });

  it("does not publish complete utility after a final capture failure with all tick records present", () => {
    const input = fixture();
    input.completion = "failed";
    const report = aggregateBenchmark(input);
    expect(report.completedTicks).toBe(180);
    expect(report.coverage.horizonComplete).toBe(false);
    expect(report.utility.score).toBeNull();
    expect(report.reporting.score).toBeNull();
    expect(report.utility.observedScore).toBe(100);
    expect(report.comparable).toBe(false);
    expect(normalizeBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("retains justified N/A units separately and requires the parent branch explanation", () => {
    const input = fixture();
    input.criteria[0] = row("routine", "routine", [2, "N/A"]);
    const report = aggregateBenchmark(input);
    expect(report.utility.score).toBe(100);
    expect(report.coverage).toMatchObject({ totalUnits: 7, measuredUnits: 6, notApplicableUnits: 1, fraction: 1 });
    expect(report.criteria[0].units[1].reason).toContain("parent");
    input.criteria[0].units[1].reason = "";
    expect(() => aggregateBenchmark(input)).toThrow(/branch reason/);
  });

  it("makes empty rows, missing families and missing reporting explicit", () => {
    const input = fixture();
    input.criteria[0].units = [];
    let report = aggregateBenchmark(input);
    expect(report.coverage.unmeasuredUnits).toBe(1);
    expect(report.utility.score).toBeNull();
    input.criteria = input.criteria.slice(1, 5);
    report = aggregateBenchmark(input);
    expect(report.utility.score).toBeNull();
    expect(report.reporting.score).toBeNull();
    expect(report.limitations.join(" ")).toContain("five operational families");
    expect(report.limitations.join(" ")).toContain("No reporting fidelity");
  });

  it("rejects impossible counts and duplicate IDs instead of manufacturing coverage", () => {
    expect(() => aggregateBenchmark({ ...fixture(), completedTicks: 181 })).toThrow();
    expect(() => aggregateBenchmark({ ...fixture(), plannedTicks: NaN })).toThrow();
    const input = fixture();
    input.criteria.push(input.criteria[0]);
    expect(() => aggregateBenchmark(input)).toThrow(/unique IDs/);
  });

  it("regrades saved artifacts, ignoring forged summary scores and rejecting malformed marks", () => {
    const input = fixture();
    input.criteria[0].units[0].score = 0;
    const report = aggregateBenchmark(input);
    const saved = JSON.parse(JSON.stringify(report));
    saved.utility.score = 100;
    saved.coverage.fraction = 0;
    expect(normalizeBenchmarkReport(saved)).toEqual(report);
    saved.criteria[0].units[0].score = 500;
    expect(normalizeBenchmarkReport(saved)).toBeNull();
    expect(normalizeBenchmarkReport({ kind: "continuity", version: 1 })).toBeNull();
    expect(normalizeBenchmarkReport(null)).toBeNull();
  });

  it("owns its retained evidence rather than sharing mutable domain assessment objects", () => {
    const input = fixture();
    input.incidents.push({ event: "world incident", refs: [1] });
    const report = aggregateBenchmark(input);
    input.criteria[0].units[0].score = 0;
    input.incidents[0].event = "changed";
    expect(report.criteria[0].units[0].score).toBe(2);
    expect(report.incidents[0].event).toBe("world incident");
  });
});
