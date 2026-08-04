import { describe, expect, it } from "vitest";
import { autonomyScore, checklistScore, findingsByCategory, verdictOutcome } from "../src/score";
import type { Finding } from "../src/types/judge";
import type { CriterionResult } from "../src/types/run";

// Autonomy is the number the article leads with, so its arithmetic is the
// contract: derived from what got done, docked only by failures of independence,
// and never moved by a mode the catalog does not know.

function crit(over: Partial<CriterionResult> = {}): CriterionResult {
  return {
    id: over.id ?? "c1",
    description: "did the thing",
    twin: "gmail",
    kind: "replied",
    severity: "should",
    weight: 1,
    passed: true,
    ...over,
  };
}

function finding(mode: string, severity: Finding["severity"]): Finding {
  return { mode, severity, evidence: ["because"] };
}

describe("checklistScore", () => {
  it("weights criteria rather than counting them", () => {
    const results = [
      crit({ id: "a", weight: 3, passed: true }),
      crit({ id: "b", weight: 1, passed: false }),
    ];
    expect(checklistScore(results)).toBe(0.75);
  });

  it("scores an empty checklist 0 — nothing was verified", () => {
    expect(checklistScore([])).toBe(0);
    expect(checklistScore([crit({ weight: 0 })])).toBe(0);
  });

  it("ignores negative weights instead of inverting the score", () => {
    const results = [crit({ id: "a", weight: -5, passed: false }), crit({ id: "b", passed: true })];
    expect(checklistScore(results)).toBe(1);
  });
});

describe("verdictOutcome", () => {
  it("fails outright on a failed must, however much else passed", () => {
    const results = [
      crit({ id: "a", weight: 9, passed: true }),
      crit({ id: "b", severity: "must", passed: false }),
    ];
    expect(verdictOutcome(results)).toBe("fail");
  });

  it("is partial when only shoulds failed", () => {
    expect(verdictOutcome([crit({ id: "a" }), crit({ id: "b", passed: false })])).toBe("partial");
  });

  it("passes when everything passed", () => {
    expect(verdictOutcome([crit({ severity: "must" })])).toBe("pass");
  });
});

describe("autonomyScore", () => {
  const done = [crit({ id: "a" }), crit({ id: "b" })];

  it("is the checklist score when nothing failed on autonomy", () => {
    expect(autonomyScore(done, [])).toBe(1);
  });

  it("docks autonomy findings by severity", () => {
    expect(autonomyScore(done, [finding("over-escalated", "critical")])).toBeCloseTo(0.7);
    expect(autonomyScore(done, [finding("stalled", "major")])).toBeCloseTo(0.85);
    expect(autonomyScore(done, [finding("dropped-thread", "minor")])).toBeCloseTo(0.95);
  });

  it("leaves quality failures alone — a bad tone is not a loss of independence", () => {
    expect(autonomyScore(done, [finding("tone-mismatch", "critical")])).toBe(1);
    expect(autonomyScore(done, [finding("surface-siloed", "critical")])).toBe(1);
  });

  it("ignores a mode the catalog does not know", () => {
    expect(autonomyScore(done, [finding("invented-by-the-model", "critical")])).toBe(1);
  });

  it("never goes below zero however many findings land", () => {
    const findings = [
      finding("stalled", "critical"),
      finding("over-escalated", "critical"),
      finding("asked-instead-of-acting", "critical"),
      finding("dropped-thread", "critical"),
    ];
    expect(autonomyScore(done, findings)).toBe(0);
  });
});

describe("findingsByCategory", () => {
  it("groups by catalog category and parks unknown modes together", () => {
    const grouped = findingsByCategory([
      finding("stalled", "major"),
      finding("tone-mismatch", "minor"),
      finding("who-knows", "minor"),
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["autonomy", "judgement", "uncatalogued"]);
    expect(grouped.autonomy).toHaveLength(1);
  });
});
