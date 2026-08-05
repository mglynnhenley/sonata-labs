import { isHarnessDefect } from "./executed";
import { getFailureMode } from "./failureModes";
import type { Finding, Severity } from "./types/judge";
import type { CriterionResult, VerdictOutcome } from "./types/run";

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
 * The criteria that are OUR fault, not the agent's — see `isHarnessDefect`.
 *
 * A subset of the undecided ones, and the subset that changes what a page is
 * allowed to say. They are already out of the score, because they are
 * `notApplicable`; what they add is that the run cannot be summed up without
 * admitting the harness never put their subject in front of the agent.
 */
export function harnessDefects(checklist: CriterionResult[]): CriterionResult[] {
  return checklist.filter(isHarnessDefect);
}

/**
 * What a verdict must say out loud about a run we cut short, or null.
 *
 * Derived from the saved rows alone — a page holding a verdict and no scenario can
 * still print it — so it names the criteria rather than the ticks. The tick count
 * is the fuller sentence and comes from `runTruncation`, which needs the spec.
 */
export function harnessNotice(checklist: CriterionResult[]): string | null {
  const ours = harnessDefects(checklist);
  if (ours.length === 0) return null;
  const musts = ours.filter((c) => c.severity === "must").length;
  const weight = musts > 0 ? `, ${musts} of them a \`must\`` : "";
  return (
    `${ours.length} of this run's ${checklist.length} criteria could not be put to the agent${weight}: ` +
    `the moment each one is about never reached it. Those are defects in this harness, not ` +
    `failures of the model, and they are excluded from the score rather than counted against it — ` +
    `${ours.map((c) => c.id).join(", ")}.`
  );
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

const OUTCOMES: readonly VerdictOutcome[] = ["pass", "partial", "fail", "inconclusive"];

/**
 * An outcome read back off disk or out of a SQLite column, or null if it is not one.
 *
 * Exists because three separate places had each written out their own
 * `x === "pass" || x === "partial" || x === "fail" ? x : null`, and every one of
 * them silently turned a fourth state into "no result" — a run the harness could
 * not grade would have come back from storage indistinguishable from a run that
 * never happened. One list, derived from the type, so the next state added is
 * added once.
 */
export function asVerdictOutcome(value: unknown): VerdictOutcome | null {
  return OUTCOMES.find((o) => o === value) ?? null;
}

/**
 * The criteria the verdict is actually about.
 *
 * The `must`s, when the spec named any: that is what `must` means, and a run that
 * met every `should` while a `must` went unchecked has not been shown to have done
 * its job. When a spec named none, nothing is privileged and every criterion is
 * load-bearing — a should-only checklist has no other floor, and the alternative is
 * that dropping the word "must" from a spec also drops the requirement to have
 * looked. A spec that wants its runs to be pass-able must say what had to happen.
 */
function decisiveCriteria(checklist: CriterionResult[]): CriterionResult[] {
  const musts = checklist.filter((c) => c.severity === "must");
  return musts.length > 0 ? musts : checklist;
}

/**
 * A failed `must` fails the whole run — the same rule the Gmail eval uses.
 *
 * A `must` nobody could decide is NOT a failed must: reporting "failed: replied
 * to the client" for a run whose mailbox was never captured is an accusation the
 * artifact cannot support. It drops out of the score, exactly as before — and it
 * now stops the verdict, which is the half that was missing. A verdict is a claim
 * about the whole run, so it may not be read off the corner of the checklist that
 * happened to be legible: `inconclusive` says the run has not been graded rather
 * than pretending it has.
 *
 * The order below is the order the evidence supports, strongest first:
 *
 *   1. a `must` that was decided and failed — blindness elsewhere does not undo a
 *      failure that was actually observed;
 *   2. nothing earned among what WAS decided — everything visible went wrong, which
 *      is a supported claim of failure whatever else could not be seen;
 *   3. any decisive criterion undecided — the run cannot be vouched for;
 *   4. otherwise pass/partial, as before.
 *
 * "Partial" still has to mean partial credit, which is why (2) sits above (3): a
 * run that scored zero on everything legible reads "fail, 0%", not "inconclusive".
 * An empty checklist is inconclusive rather than failed — a spec that asked for
 * nothing verified nothing, and that is the spec's defect, not the agent's.
 *
 * (2) has ONE exception, and it is the whole of this pass. "Everything visible went
 * wrong" is a supported claim of failure only when the visible set is the day. On a
 * run we cut short it is the fraction of the day our harness happened to deliver,
 * and reading a verdict off it publishes our interruption as the model's failure.
 * (1) is untouched by that: a `must` that was decided and failed was failed on a
 * moment the agent WAS shown, and a short day afterwards does not undo it.
 */
export function verdictOutcome(checklist: CriterionResult[]): VerdictOutcome {
  if (checklist.length === 0) return "inconclusive";

  const decided = decidedCriteria(checklist);
  const ours = harnessDefects(checklist).length > 0;
  if (decided.some((c) => c.severity === "must" && c.status === "failed")) return "fail";
  if (decided.length > 0 && !decided.some((c) => c.status === "passed")) {
    return ours ? "inconclusive" : "fail";
  }
  if (decisiveCriteria(checklist).some((c) => c.status === "notApplicable")) return "inconclusive";
  if (decided.length === 0) return "inconclusive";
  return decided.every((c) => c.status === "passed") ? "pass" : "partial";
}

/**
 * The headline number and the confidence in it, which are one fact and not two.
 *
 * "100%" off one of four criteria and "100%" off four of four are different claims
 * about a run, and they used to render identically because the percentage was the
 * only thing a caller was handed. Everything that quotes the score gets the counts
 * with it, so a UI cannot show the number without being able to show what it was
 * computed over.
 *
 * The percentage itself is unchanged — `checklistScore`, `notApplicable` excluded
 * from both sides. This adds the denominator's provenance, not new arithmetic.
 */
export interface ScoredChecklist {
  /** Weighted fraction of the DECIDED checklist that passed, 0..1. */
  score: number;
  /** Criteria this run settled either way — what `score` is a fraction OF. */
  decided: number;
  /** Criteria the spec asked for, decided or not. */
  total: number;
  /** `must`s nothing could decide — why an `inconclusive` run is inconclusive. */
  undecidedMusts: number;
  /** How many of those are OUR defect: the agent was never shown their subject. */
  harnessDefects: number;
  /** What the page must say about them, in our own voice. Null when there are none. */
  notice: string | null;
  outcome: VerdictOutcome;
}

export function scoreChecklist(checklist: CriterionResult[]): ScoredChecklist {
  return {
    score: checklistScore(checklist),
    decided: decidedCriteria(checklist).length,
    total: checklist.length,
    undecidedMusts: checklist.filter(
      (c) => c.severity === "must" && c.status === "notApplicable",
    ).length,
    harnessDefects: harnessDefects(checklist).length,
    notice: harnessNotice(checklist),
    outcome: verdictOutcome(checklist),
  };
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
