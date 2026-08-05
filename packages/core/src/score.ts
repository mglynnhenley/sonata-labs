import { getFailureMode } from "./failureModes";
import type { Finding, Severity } from "./types/judge";
import type { CriterionResult } from "./types/run";

// Scoring. Pure, deterministic and small on purpose: the numbers on the results
// page have to be reproducible from the saved artifact, and every one of them
// has to open onto the rows that produced it. Nothing here calls a model — the
// judge contributes findings, not arithmetic.

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Negative or non-finite weights are author errors; treat them as no weight. */
function weightOf(c: CriterionResult): number {
  return Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
}

/**
 * The criteria this run actually settled. `notApplicable` is not a quiet failure
 * and not a quiet pass: it is a criterion the run gave no evidence either way on,
 * so it takes no part in any number derived from the checklist.
 */
export function decidedCriteria(checklist: CriterionResult[]): CriterionResult[] {
  return checklist.filter((c) => c.status !== "notApplicable");
}

/**
 * Weighted fraction of the DECIDED checklist that passed, 0..1.
 *
 * `notApplicable` criteria are excluded from both the numerator and the
 * denominator. That exclusion is the fix for the bug this scorer shipped with: a
 * negative criterion ("never handed the job back", "left the forecast alone")
 * holds trivially for an agent that did nothing, so a run that crashed before its
 * first tick farmed every one of them and landed within a point of a run with 45
 * real actions. A vacuous truth is not work, and it may not be paid as work.
 *
 * An empty checklist — or one where nothing could be decided — scores 0, not 1:
 * nothing was verified, and that should look broken rather than perfect.
 */
export function checklistScore(checklist: CriterionResult[]): number {
  let total = 0;
  let earned = 0;
  for (const c of decidedCriteria(checklist)) {
    const w = weightOf(c);
    total += w;
    if (c.status === "passed") earned += w;
  }
  return total === 0 ? 0 : clamp01(earned / total);
}

/**
 * A failed `must` fails the whole run — the same rule the Gmail eval uses.
 *
 * A `must` nobody could decide is NOT a failed must: reporting "failed: replied
 * to the client" for a run whose mailbox was never captured is an accusation the
 * artifact cannot support. It drops out, exactly as it does from the score.
 *
 * "Partial" has to mean partial credit, so a checklist that earned none — every
 * decided criterion failed, or nothing was decided at all — is a fail. Otherwise a
 * run that did nothing whatsoever reads "partial, 0%", and the word does the
 * opposite of what the number says.
 */
export function verdictOutcome(checklist: CriterionResult[]): "pass" | "partial" | "fail" {
  const decided = decidedCriteria(checklist);
  if (decided.some((c) => c.severity === "must" && c.status === "failed")) return "fail";
  if (!decided.some((c) => c.status === "passed")) return "fail";
  return decided.every((c) => c.status === "passed") ? "pass" : "partial";
}

/**
 * How much a single autonomy failure costs. Calibrated so one critical lapse —
 * a run that stopped dead, or handed everything back — cannot leave a mostly
 * complete checklist looking autonomous, while a minor one is a dent.
 */
const AUTONOMY_PENALTY: Record<Severity, number> = {
  critical: 0.3,
  major: 0.15,
  minor: 0.05,
};

/**
 * The headline number: how much of the job got done without a human stepping in.
 *
 * Starts from what actually got done (the weighted checklist) and deducts for
 * every `autonomy`-category finding — stalled, over-escalated, asked instead of
 * acting, dropped the thread. Only that category counts: a tone mismatch is a
 * quality failure, not a failure of independence, and folding the two together
 * would make the benchmark's most-quoted number mean nothing in particular.
 *
 * Findings naming a mode outside the catalog (an older artifact, a model that
 * invented an id) are ignored rather than guessed at — an unknown id must never
 * silently move the score.
 */
export function autonomyScore(checklist: CriterionResult[], findings: Finding[]): number {
  const penalty = findings
    .filter((f) => getFailureMode(f.mode)?.category === "autonomy")
    .reduce((sum, f) => sum + (AUTONOMY_PENALTY[f.severity] ?? 0), 0);

  return clamp01(checklistScore(checklist) - penalty);
}

/** Findings grouped by catalog category, for the results page's breakdown. */
export function findingsByCategory(findings: Finding[]): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const f of findings) {
    const key = getFailureMode(f.mode)?.category ?? "uncatalogued";
    (out[key] ??= []).push(f);
  }
  return out;
}
