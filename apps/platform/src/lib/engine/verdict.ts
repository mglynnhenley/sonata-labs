import { randomUUID } from "node:crypto";
import { AssessmentBusyError, evidenceHash, preserveLegacyReport, writeAssessment, type Assessment } from "./assessments";
import path from "node:path";
import { acquireResourceLease, ResourceBusyError } from "./cloneLease";
import {
  checklistScore,
  episodeTwins,
  runExecution,
  runTruncation,
  verdictOutcome,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type RunCost,
  type RunExecution,
  type TwinAuditRow,
} from "@sonata/core";
import {
  autonomy,
  escalationsFromTicks,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  checklistWithUnjudged,
  writtenFromTicks,
} from "@sonata/judge";
import {
  beginJudgeAttempt,
  finishJudgeAttempt,
  type JudgeSpend,
} from "../../../app/api/results/_lib/judgeAttempt";
import { judgeModelFor, rejudgeRun } from "../../../app/api/results/_lib/rejudge";
import { readRun, readSpec, updateRunJudge, runsDir } from "../../../app/results/_lib/artifacts";
import { finishRun, getRun } from "../db";

// What a finished day is worth.
//
// Two halves, and they never mix. The checklist is deterministic — it ran in
// code against the real state of each twin, so it is a fact and a re-judge must
// never move it. The judge is the model's half: it reads the saved day and names
// how the agent failed, and it is a separate pass on purpose, so a score appears
// the moment the day ends rather than a judge call later.
//
// The judge path is the dashboard's own `rejudgeRun`, called directly. There is
// exactly one judge prompt in this product, and the run that judges itself at
// the end and the button that re-judges it next week must be the same code.

const ZERO_COST: RunCost = { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 };

export interface ScoreInput {
  /** Every twin's audit rows for the run, from the engine. */
  audit?: TwinAuditRow[];
  cost?: RunCost;
}

export interface ScoredRun {
  /** Empty when the run did not execute — there is nothing to show criteria for. */
  checklist: CriterionResult[];
  /** Null when the run did not execute. Absent, not zero. */
  verdict: EpisodeVerdict | null;
  execution: RunExecution;
}

/**
 * Score a finished run against its own checklist.
 *
 * The deterministic half, and the whole of it: refs the beats minted, what each
 * twin's log says the agent actually did, both snapshots, the prose it wrote, and
 * how much of the declared day actually ran. `runChecklist` decides; nothing here
 * interprets. `judged` criteria carry no verdict here — a criterion no checker
 * could decide must not drag a score that claims to report what was verified.
 * They reach the judge as questions instead.
 *
 * But they may not vanish. While no judge report exists for the run — disabled,
 * failed, or not yet run — each of them is a `notApplicable` row saying so, in
 * the judge's absence rather than the agent's fault. The rows come from the same
 * `deferred` list the judge is asked from, so the two can never disagree about
 * which criteria those are. Once a report exists the judge owns those criteria
 * and the rows are not minted.
 *
 * A run that never executed is not scored at all — see `runExecution`. It returns
 * an empty checklist with it, because the criteria such a run "passes" are the
 * negative ones it passed by doing nothing, and printing those as evidence is how
 * a crash came to look like a mid-table result.
 */
export function scoreRun(run: EpisodeRun, spec: EpisodeSpec, input: ScoreInput = {}): ScoredRun {
  const execution = runExecution(run);
  // Domain rubrics carry per-unit partial credit and explicit unknowns. An empty
  // legacy checklist cannot substitute for that separate report.
  if (spec.benchmark) return { checklist: [], verdict: null, execution };
  if (!execution.executed) return { checklist: [], verdict: null, execution };

  const existing = run.verdict;
  const judge = existing?.judge ?? null;
  const stored = existing && existing.checklist.length > 0 ? existing.checklist : null;
  // Pure and offline, so re-running it over stored rows costs nothing and changes
  // nothing: the stored rows stay the record, and only the deferred list is read.
  const outcome =
    stored && judge
      ? null
      : runChecklist({
          criteria: spec.success.checklist,
          world: spec.world,
          beats: spec.beats,
          refs: refsFromTicks(run.ticks),
          snapshots: run.snapshots,
          audit: input.audit ?? [],
          escalations: escalationsFromTicks(run.ticks),
          written: writtenFromTicks(run.ticks),
          // Which ticks ran, so a deadline the day never reached is reported as
          // unmeasured rather than as the agent's failure, and a beat that never
          // fired says which tick it was scheduled for.
          truncation: runTruncation(run, spec),
          tickOf: tickIndexer(run.ticks),
        });
  const checked = stored ?? outcome?.results ?? [];
  const checklist =
    outcome && !judge
      ? checklistWithUnjudged(
          { results: checked, deferred: outcome.deferred },
          spec.success.checklist,
        )
      : checked;

  return {
    checklist,
    execution,
    verdict: {
      outcome: verdictOutcome(checklist),
      score: checklistScore(checklist),
      // @sonata/judge's `autonomy` is the definition of the headline number, and
      // it reads the run rather than the judge's opinion of it: same artifact in,
      // same number out, months later, with no key. That is what lets the runs
      // list and the run page quote one figure — nothing downstream of the judge
      // can move it.
      autonomy: autonomy(checklist, run.ticks).score,
      checklist,
      judge,
      cost: input.cost ?? existing?.cost ?? ZERO_COST,
    },
  };
}

export interface JudgeResult {
  assessment: Assessment;
  report: EpisodeJudgeReport;
  /** The run's own autonomy, re-read off the artifact the report was written to. */
  autonomy: number;
  /** What this pass cost. Null when the provider priced nothing. */
  spend: JudgeSpend | null;
}

/**
 * How the engine and a session note a judge that fell over, verbatim.
 *
 * Owned by them (`episode.ts`, `session.ts`), matched here for one purpose: a
 * pass that has now SUCCEEDED has to be able to take that note back down. See
 * where it is used.
 */
const JUDGE_FAILED_NOTE = "The day finished, but the judge did not";

/**
 * Every initial assessment and rejudge uses this path. Inspect runs the judge;
 * immutable assessment records preserve history, while updateRunJudge refreshes
 * the latest display copy and the dashboard row. The recorded day is not replayed.
 */
export async function judgeRun(
  run: EpisodeRun,
  spec: EpisodeSpec | null,
  opts: { model?: string; signal?: AbortSignal; manual?: boolean } = {},
): Promise<JudgeResult> {
  // The same bar the score uses. A judge reading a day the agent never worked
  // would write a diagnosis of nothing, and that diagnosis would then be quoted
  // as a finding about a model. Nothing is recorded for it either: a day with no
  // work in it was never a candidate, so it has no failed attempt to explain.
  if (spec?.benchmark) throw new Error("Continuity cases use their persisted domain rubric. Free-text judge calibration is not implemented.");
  const execution = runExecution(run);
  if (!execution.executed) {
    throw new Error(`This run cannot be assessed. ${execution.reason ?? ""}`.trim());
  }

  let release: () => void;
  try { release = acquireResourceLease([`assessment:${path.resolve(runsDir(), run.runId)}`], `assessment of ${run.runId}`); }
  catch (error) { if (error instanceof ResourceBusyError) throw new AssessmentBusyError(); throw error; }
  try {
    preserveLegacyReport(run.runId, run.verdict?.judge ?? null);
    const truncation = spec ? runTruncation(run, spec) : null;
    const numericScoreEligible = Boolean(spec && truncation && !truncation.truncated && !truncation.unfired.length &&
      episodeTwins(spec).every(twin => run.snapshots[twin]?.before && run.snapshots[twin]?.after));
    const assessment: Assessment = {
      id: randomUUID(), runId: run.runId, ownerPid: process.pid, model: judgeModelFor(opts.model), runner: "inspect",
      startedAt: Date.now(), endedAt: null, status: "judging", automatic: opts.manual !== true,
      report: null, spend: null, error: null, log: null,
      provenance: { numericScoreEligible, sourceRunId: run.runId, sourceInspectLog: run.inspect?.log ?? null,
        evidenceSha256: evidenceHash({ ticks: run.ticks, snapshots: run.snapshots, audit: run.audit, spec }),
        gradingVersion: "sonata-inspect-judge-v1" },
    };
    writeAssessment(assessment);
    const attempt = beginJudgeAttempt({ runId: run.runId, model: assessment.model, automatic: assessment.automatic });
    let spend: JudgeSpend | null = null;
    let report: EpisodeJudgeReport;
    let verdict: EpisodeVerdict | null;
    try {
      report = await rejudgeRun(run, spec, {
        assessment, model: assessment.model, signal: opts.signal, onSpend: s => { spend = s; },
      });
      assessment.report = report;
      assessment.spend = spend;
      assessment.status = "judged";
      assessment.endedAt = Date.now();
      // Immutable history is the record. The old locations are the latest display copy.
      writeAssessment(assessment);
      verdict = updateRunJudge(run.runId, report);
      if (!verdict) throw new Error("Assessment saved, but its run artifact could not be updated.");
      finishJudgeAttempt(attempt, { state: "judged", spend });
    } catch (err) {
      assessment.status = "failed";
      assessment.error = err instanceof Error ? err.message : String(err);
      assessment.spend = spend;
      assessment.endedAt = Date.now();
      writeAssessment(assessment);
      finishJudgeAttempt(attempt, { state: "failed", reason: assessment.error, spend });
      throw err;
    }
    const headline = verdict.autonomy;

    // The runs list reads the relational row, not the file, so the headline number
    // has to move in both places or the two pages disagree about the same run.
    const row = getRun(run.runId);
    if (row) {
      // A note saying the judge did not finish, on a run that has just been
      // judged, is the runs list flagging a day whose diagnosis is on screen. Only
      // that note is dropped; any other error belongs to the day itself.
      const keepError = row.error && !row.error.startsWith(JUDGE_FAILED_NOTE) ? row.error : null;
      finishRun({
        id: run.runId,
        status: row.status === "judging" ? "done" : row.status,
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.score === null ? {} : { score: row.score }),
        autonomy: headline,
        ...(keepError ? { error: keepError } : {}),
        endedAt: row.endedAt ?? Date.now(),
      });
    }

    return { assessment, report, autonomy: headline, spend };
  } finally {
    release();
  }
}

/**
 * `sonata judge <runId>` — judge a day that finished long ago, from its file.
 * Nothing live is needed: the artifact carries the whole day.
 */
export async function judgeSavedRun(
  runId: string,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<JudgeResult> {
  const run = readRun(runId);
  if (!run) throw new Error(`No run artifact for ${runId}.`);
  if (run.status === "queued" || run.status === "running") {
    throw new Error("This run is still going. Let the day finish, then judge it.");
  }
  // The spec, not the brief: the judge reads the clock and the beats too, and
  // `RunBrief` is the four fields a PAGE needs. Null on an artifact written
  // before specs were embedded — see `buildJudgeInput` for what that costs.
  return judgeRun(run, readSpec(runId), opts);
}
