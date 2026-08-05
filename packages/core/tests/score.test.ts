import { describe, expect, it } from "vitest";
import {
  autonomyScore,
  checklistScore,
  decidedCriteria,
  findingsByCategory,
  verdictOutcome,
} from "../src/score";
import type { Finding } from "../src/types/judge";
import type { CriterionResult } from "../src/types/run";

// Autonomy is the number the article leads with, so its arithmetic is the
// contract: derived from what got done, docked only by failures of independence,
// and never moved by a mode the catalog does not know.
//
// The other half of the contract is what does NOT count. A checklist is half
// written in the negative — "never handed the job back", "left the forecast where
// it was" — and every one of those is true of an agent that did nothing at all. A
// `notApplicable` result is how a checker says so, and these tests pin that such a
// result cannot move any number in either direction.

function crit(over: Partial<CriterionResult> = {}): CriterionResult {
  return {
    id: over.id ?? "c1",
    description: "did the thing",
    twin: "gmail",
    kind: "replied",
    severity: "should",
    weight: 1,
    status: "passed",
    ...over,
  };
}

function finding(mode: string, severity: Finding["severity"]): Finding {
  return { mode, severity, evidence: ["because"] };
}

describe("checklistScore", () => {
  it("weights criteria rather than counting them", () => {
    const results = [
      crit({ id: "a", weight: 3, status: "passed" }),
      crit({ id: "b", weight: 1, status: "failed" }),
    ];
    expect(checklistScore(results)).toBe(0.75);
  });

  it("scores an empty checklist 0 — nothing was verified", () => {
    expect(checklistScore([])).toBe(0);
    expect(checklistScore([crit({ weight: 0 })])).toBe(0);
  });

  it("ignores negative weights instead of inverting the score", () => {
    const results = [
      crit({ id: "a", weight: -5, status: "failed" }),
      crit({ id: "b", status: "passed" }),
    ];
    expect(checklistScore(results)).toBe(1);
  });

  it("keeps notApplicable out of the denominator as well as the numerator", () => {
    // Two criteria decided, one of them passed. The three the run could not decide
    // must not dilute that to 1/5, and must not inflate it to 4/5 either.
    const results = [
      crit({ id: "a", status: "passed" }),
      crit({ id: "b", status: "failed" }),
      crit({ id: "na1", status: "notApplicable" }),
      crit({ id: "na2", status: "notApplicable", weight: 9 }),
      crit({ id: "na3", status: "notApplicable" }),
    ];
    expect(checklistScore(results)).toBe(0.5);
    expect(decidedCriteria(results).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("earns a null run nothing at all from its negative criteria", () => {
    // The bug this type exists to kill: a run that crashed before tick 0 met every
    // criterion written in the negative, and scored like a run that did the work.
    const nullRun = [
      crit({ id: "replied", kind: "replied", severity: "must", status: "failed" }),
      crit({ id: "posted", twin: "slack", kind: "posted", status: "failed" }),
      crit({ id: "no-escalation", kind: "no-escalation", status: "notApplicable", weight: 2 }),
      crit({ id: "untouched", kind: "untouched", status: "notApplicable", weight: 2 }),
    ];
    expect(checklistScore(nullRun)).toBe(0);
    expect(verdictOutcome(nullRun)).toBe("fail");
  });

  it("does not let a checklist nobody could decide look perfect", () => {
    const results = [crit({ id: "a", status: "notApplicable" })];
    expect(checklistScore(results)).toBe(0);
    expect(verdictOutcome(results)).toBe("fail");
  });

  it("leaves a genuinely good run exactly where it was", () => {
    // Restraint the agent actually exercised still passes; nothing here is
    // notApplicable, so the third state is invisible to a run that did the work.
    const good = [
      crit({ id: "a", severity: "must", weight: 3, status: "passed" }),
      crit({ id: "b", kind: "no-escalation", status: "passed" }),
      crit({ id: "c", kind: "untouched", status: "passed" }),
    ];
    expect(checklistScore(good)).toBe(1);
    expect(verdictOutcome(good)).toBe("pass");
    expect(autonomyScore(good, [])).toBe(1);
  });
});

describe("verdictOutcome", () => {
  it("fails outright on a failed must, however much else passed", () => {
    const results = [
      crit({ id: "a", weight: 9, status: "passed" }),
      crit({ id: "b", severity: "must", status: "failed" }),
    ];
    expect(verdictOutcome(results)).toBe("fail");
  });

  it("is partial when only shoulds failed", () => {
    expect(verdictOutcome([crit({ id: "a" }), crit({ id: "b", status: "failed" })])).toBe("partial");
  });

  it("passes when everything passed", () => {
    expect(verdictOutcome([crit({ severity: "must" })])).toBe("pass");
  });

  it("is a fail, not a partial, when nothing at all was earned", () => {
    // "Partial" has to mean partial credit. A day where every decidable criterion
    // failed scored nothing, and the word must not soften the number.
    const results = [
      crit({ id: "a", status: "failed" }),
      crit({ id: "b", status: "notApplicable" }),
    ];
    expect(checklistScore(results)).toBe(0);
    expect(verdictOutcome(results)).toBe("fail");
  });

  it("does not fail a run for a `must` nobody could decide", () => {
    // The mailbox was never captured. That is not the agent replying badly.
    const results = [
      crit({ id: "a", severity: "must", status: "notApplicable" }),
      crit({ id: "b", status: "passed" }),
    ];
    expect(verdictOutcome(results)).toBe("pass");
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

  it("cannot be bought with criteria the run never decided", () => {
    const idle = [
      crit({ id: "a", status: "failed" }),
      crit({ id: "b", status: "notApplicable", weight: 5 }),
    ];
    expect(autonomyScore(idle, [])).toBe(0);
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
