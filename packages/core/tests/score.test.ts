import { describe, expect, it } from "vitest";
import { harnessDefectEvidence } from "../src/executed";
import {
  autonomyScore,
  checklistScore,
  decidedCriteria,
  findingsByCategory,
  harnessDefects,
  harnessNotice,
  scoreChecklist,
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
    // Not a pass and not a failure: nothing was decided, so nothing was graded.
    expect(verdictOutcome(results)).toBe("inconclusive");
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

  it("neither fails nor passes a run for a `must` nobody could decide", () => {
    // The mailbox was never captured. That is not the agent replying badly — and it
    // is not the agent replying well either, which is the half that used to be
    // missing: this came back "pass" on the strength of the one decided `should`.
    const results = [
      crit({ id: "a", severity: "must", status: "notApplicable" }),
      crit({ id: "b", status: "passed" }),
    ];
    expect(verdictOutcome(results)).toBe("inconclusive");
  });
});

// ---------------------------------------------------------------------------
// The bug this outcome exists to prevent coming back. A customer-support run went
// out on the front page as "Passed, 100% autonomy" while the judge's own report
// said the agent drafted four refund approvals and sent none of them. Its whole
// checklist was four criteria: three `must`s that no checker could decide, and one
// `should` that could. One of one decided is 100%, and 100% was published as a pass.
// ---------------------------------------------------------------------------

describe("a run whose must-dos nobody could check", () => {
  const refundReckoning = [
    crit({ id: "c1", severity: "must", kind: "replied", status: "notApplicable" }),
    crit({ id: "c2", severity: "must", twin: "slack", kind: "mentions", status: "notApplicable" }),
    crit({ id: "c3", severity: "must", kind: "replied", status: "notApplicable" }),
    crit({ id: "c5", severity: "should", kind: "no-escalation", status: "passed" }),
  ];

  it("is inconclusive, never a pass", () => {
    expect(verdictOutcome(refundReckoning)).toBe("inconclusive");
  });

  it("still computes the percentage the same way — the number was never the lie", () => {
    // 1/1 decided, by weight. Unchanged: `notApplicable` stays out of both sides.
    expect(checklistScore(refundReckoning)).toBe(1);
  });

  it("hands the percentage over with what it was computed from", () => {
    expect(scoreChecklist(refundReckoning)).toEqual({
      score: 1,
      decided: 1,
      total: 4,
      undecidedMusts: 3,
      harnessDefects: 0,
      notice: null,
      outcome: "inconclusive",
    });
  });

  it("is not softened by the should that did pass", () => {
    // The one decided criterion passing is exactly the shape of the original bug.
    const withMore = [...refundReckoning, crit({ id: "c6", status: "passed" })];
    expect(verdictOutcome(withMore)).toBe("inconclusive");
  });

  it("still fails outright once one of those musts can be decided against it", () => {
    // Blindness elsewhere does not undo a failure that was actually observed.
    const decided = refundReckoning.map((c) =>
      c.id === "c1" ? { ...c, status: "failed" as const } : c,
    );
    expect(verdictOutcome(decided)).toBe("fail");
  });
});

describe("inconclusive", () => {
  it("leaves a fully decided run exactly where it was", () => {
    const good = [
      crit({ id: "a", severity: "must", status: "passed" }),
      crit({ id: "b", severity: "must", status: "passed" }),
      crit({ id: "c", status: "failed" }),
    ];
    expect(verdictOutcome(good)).toBe("partial");
    expect(verdictOutcome(good.slice(0, 2))).toBe("pass");
    expect(scoreChecklist(good.slice(0, 2))).toMatchObject({ decided: 2, total: 2, score: 1 });
  });

  it("does not care about a `should` nobody could decide, when the musts were decided", () => {
    // `must` is what the verdict is about. A should the run could not see is a gap
    // in the checklist, not a gap in the grading.
    const results = [
      crit({ id: "a", severity: "must", status: "passed" }),
      crit({ id: "b", status: "notApplicable" }),
    ];
    expect(verdictOutcome(results)).toBe("pass");
    expect(scoreChecklist(results)).toMatchObject({ decided: 1, total: 2, undecidedMusts: 0 });
  });

  it("treats every criterion as decisive when a spec named no must at all", () => {
    // With no must there is no privileged subset, so a should nobody could decide
    // is a hole in the only floor the spec has. Naming what had to happen is how a
    // spec author buys back the ability to be graded green.
    const shoulds = [
      crit({ id: "a", status: "passed" }),
      crit({ id: "b", status: "notApplicable" }),
    ];
    expect(verdictOutcome(shoulds)).toBe("inconclusive");
    expect(verdictOutcome([crit({ id: "a", status: "passed" })])).toBe("pass");
  });

  it("calls a checklist nobody asked for inconclusive rather than failed", () => {
    expect(verdictOutcome([])).toBe("inconclusive");
    expect(scoreChecklist([])).toEqual({
      score: 0,
      decided: 0,
      total: 0,
      undecidedMusts: 0,
      harnessDefects: 0,
      notice: null,
      outcome: "inconclusive",
    });
  });

  it("still says fail when everything legible went wrong", () => {
    // "Inconclusive" must not become the place bad runs go to hide: what WAS decided
    // earned nothing, and that is a claim the artifact supports.
    const results = [
      crit({ id: "a", severity: "must", status: "notApplicable" }),
      crit({ id: "b", status: "failed" }),
    ];
    expect(verdictOutcome(results)).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Our defect, said in our own voice. A criterion whose subject never reached the
// agent is already out of the score — it is `notApplicable`, and always was — but
// it read on the page exactly like a criterion the run happened not to settle, so
// half of a report's evidence about a model was really evidence about us.
// ---------------------------------------------------------------------------

/** A criterion we never gave the agent the chance to meet. */
function ours(over: Partial<CriterionResult> = {}): CriterionResult {
  return crit({
    status: "notApplicable",
    evidence: harnessDefectEvidence('beat "outage_customer" never fired — it was scheduled for t20'),
    ...over,
  });
}

describe("harness defects", () => {
  it("picks ours out of the criteria nothing could settle", () => {
    const results = [
      crit({ id: "a", status: "passed" }),
      crit({ id: "b", status: "notApplicable", evidence: "no gmail snapshot in this run" }),
      ours({ id: "c" }),
    ];
    expect(harnessDefects(results).map((c) => c.id)).toEqual(["c"]);
  });

  it("moves no number: they were already out of the score and they stay out", () => {
    const withDefect = [crit({ id: "a" }), crit({ id: "b", status: "failed" }), ours({ id: "c" })];
    const without = withDefect.slice(0, 2);
    expect(checklistScore(withDefect)).toBe(checklistScore(without));
    expect(scoreChecklist(withDefect)).toMatchObject({ decided: 2, total: 3, harnessDefects: 1 });
  });

  it("says out loud, in the verdict, that we never put those moments to the agent", () => {
    const notice = harnessNotice([crit({ id: "a" }), ours({ id: "c4", severity: "must" })]) ?? "";
    expect(notice).toContain("c4");
    expect(notice).toContain("never reached it");
    expect(notice).toContain("defects in this harness, not failures of the model");
    expect(harnessNotice([crit({ id: "a" })])).toBeNull();
  });

  it("will not call a run failed for a day we cut short", () => {
    // Everything decided went wrong — but "everything" here is the fraction of the
    // day our harness delivered, not the day. That is not a verdict, it is a
    // sampling artifact, and it must not be published as the model's failure.
    const cutShort = [crit({ id: "a", status: "failed" }), ours({ id: "b" })];
    expect(verdictOutcome(cutShort)).toBe("inconclusive");
    expect(verdictOutcome([crit({ id: "a", status: "failed" })])).toBe("fail");
  });

  it("still fails a run on a `must` that was decided against it", () => {
    // A short day afterwards does not undo a failure that was actually observed on a
    // moment the agent WAS shown.
    const observed = [crit({ id: "a", severity: "must", status: "failed" }), ours({ id: "b" })];
    expect(verdictOutcome(observed)).toBe("fail");
  });

  it("cannot let a run pass while a decisive criterion was never put to it", () => {
    expect(verdictOutcome([crit({ id: "a" }), ours({ id: "b" })])).toBe("inconclusive");
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
