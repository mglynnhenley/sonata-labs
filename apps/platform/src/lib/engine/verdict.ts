import {
  checklistScore,
  runExecution,
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
  writtenFromTicks,
} from "@sonata/judge";
import {
  beginJudgeAttempt,
  finishJudgeAttempt,
  type JudgeSpend,
} from "../../../app/api/results/_lib/judgeAttempt";
import { judgeModelFor, rejudgeRun } from "../../../app/api/results/_lib/rejudge";
import { readRun, readSpec, updateRunJudge } from "../../../app/results/_lib/artifacts";
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
 * twin's log says the agent actually did, both snapshots, and the prose it
 * wrote. `runChecklist` decides; nothing here interprets. `judged` criteria are
 * deliberately absent from the result — a criterion no checker could decide must
 * not drag a score that claims to report what was verified. They reach the judge
 * as questions instead.
 *
 * A run that never executed is not scored at all — see `runExecution`. It returns
 * an empty checklist with it, because the criteria such a run "passes" are the
 * negative ones it passed by doing nothing, and printing those as evidence is how
 * a crash came to look like a mid-table result.
 */
export function scoreRun(run: EpisodeRun, spec: EpisodeSpec, input: ScoreInput = {}): ScoredRun {
  const execution = runExecution(run);
  if (!execution.executed) return { checklist: [], verdict: null, execution };

  const existing = run.verdict;
  const checklist =
    existing && existing.checklist.length > 0
      ? existing.checklist
      : runChecklist({
          criteria: spec.success.checklist,
          world: spec.world,
          refs: refsFromTicks(run.ticks),
          snapshots: run.snapshots,
          audit: input.audit ?? [],
          escalations: escalationsFromTicks(run.ticks),
          written: writtenFromTicks(run.ticks),
          tickOf: tickIndexer(run.ticks),
        }).results;

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
      judge: existing?.judge ?? null,
      cost: input.cost ?? existing?.cost ?? ZERO_COST,
    },
  };
}

export interface JudgeResult {
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
 * Judge a day, write the report to `<runId>.judge.json`, and fold it back into
 * the run's verdict.
 *
 * Both writes go through `updateRunJudge`. The separate judge artifact is the
 * point of the split — `sonata judge <runId> --model X` overwrites one small
 * file and the day never re-runs — and the run file is read-modify-written
 * rather than rebuilt, because the engine owns it and may have put fields in it
 * this dashboard does not model.
 *
 * EVERY judge pass in the product comes through here: the engine at the close of
 * a run, a session settling, `sonata judge`, and the Re-judge button. So this is
 * the one place that has to open and close the attempt record — the file that
 * lets a page distinguish "reading it now" from "it answered and was cut off"
 * from "nobody ever asked". A trigger of its own for the dashboard would have
 * been a second way to judge, and this product has exactly one.
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
  const execution = runExecution(run);
  if (!execution.executed) {
    throw new Error(`There is nothing for a judge to read. ${execution.reason ?? ""}`.trim());
  }

  const attempt = beginJudgeAttempt({
    runId: run.runId,
    model: judgeModelFor(opts.model),
    // The default is automatic because the callers that pass nothing are the
    // engine and the CLI finishing a day. Only the button says otherwise.
    automatic: opts.manual !== true,
  });
  // Held outside the try: a pass that answered and then failed to parse was paid
  // for, and the bill is part of what the failure has to be able to say.
  let spend: JudgeSpend | null = null;

  let report: EpisodeJudgeReport;
  try {
    report = await rejudgeRun(run, spec, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onSpend: (s) => (spend = s),
    });
  } catch (err) {
    finishJudgeAttempt(attempt, {
      state: "failed",
      reason: err instanceof Error ? err.message : String(err),
      spend,
    });
    throw err;
  }
  finishJudgeAttempt(attempt, { state: "judged", spend });

  const verdict = updateRunJudge(run.runId, report);
  const headline = verdict?.autonomy ?? autonomy(run.verdict?.checklist ?? [], run.ticks).score;

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

  return { report, autonomy: headline, spend };
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
