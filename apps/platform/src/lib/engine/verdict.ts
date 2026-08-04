import {
  autonomyScore,
  checklistScore,
  offsetMinutes,
  verdictOutcome,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type RunCost,
  type TwinAuditRow,
} from "@sonata/core";
import {
  escalationsFromTicks,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "@sonata/judge";
import { rejudgeRun } from "../../../app/api/results/_lib/rejudge";
import { readBrief, readRun, updateRunJudge, type RunBrief } from "../../../app/results/_lib/artifacts";
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

/**
 * Score a finished run against its own checklist.
 *
 * The deterministic half, and the whole of it: refs the beats minted, what each
 * twin's log says the agent actually did, both snapshots, and the prose it
 * wrote. `runChecklist` decides; nothing here interprets. `judged` criteria are
 * deliberately absent from the result — a criterion no checker could decide must
 * not drag a score that claims to report what was verified. They reach the judge
 * as questions instead.
 */
export function scoreRun(
  run: EpisodeRun,
  spec: EpisodeSpec,
  input: ScoreInput = {},
): { checklist: CriterionResult[]; verdict: EpisodeVerdict } {
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
    verdict: {
      outcome: verdictOutcome(checklist),
      score: checklistScore(checklist),
      autonomy: autonomyScore(checklist, existing?.judge?.findings ?? []),
      checklist,
      judge: existing?.judge ?? null,
      cost: input.cost ?? existing?.cost ?? ZERO_COST,
    },
  };
}

/** `offsetMinutes` throws on an offsetless string; a bad spec must not lose a run. */
function safeOffset(iso: string): number {
  try {
    return offsetMinutes(iso);
  } catch {
    return 0;
  }
}

/**
 * The brief the judge reads, built from the spec in hand. The disk equivalent is
 * `readBrief`, which digs the same four fields out of a saved artifact — this is
 * for the run that has only just ended and still has its spec.
 */
export function briefFor(spec: EpisodeSpec): RunBrief {
  const people: Record<string, string> = {};
  for (const person of spec.world.cast) people[person.id] = person.name;
  return {
    task: spec.task,
    story: spec.story,
    judgeQuestions: spec.success.judgeQuestions,
    offsetMinutes: safeOffset(spec.clock.startISO),
    people,
  };
}

export interface JudgeResult {
  report: EpisodeJudgeReport;
  /** Re-derived from the findings, so it moves with them. */
  autonomy: number;
}

/**
 * Judge a day and write the report back onto its artifact.
 *
 * The write-back goes through `updateRunJudge`, which read-modify-writes the raw
 * file: the engine owns that file and may have written fields this dashboard
 * does not model, and a judge pass must never be the thing that drops them.
 */
export async function judgeRun(
  run: EpisodeRun,
  brief: RunBrief,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<JudgeResult> {
  if (run.ticks.length === 0) {
    throw new Error("This run recorded no ticks, so there is nothing for a judge to read.");
  }

  const report = await rejudgeRun(run, brief, {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const verdict = updateRunJudge(run.runId, report);
  const autonomy = verdict?.autonomy ?? autonomyScore(run.verdict?.checklist ?? [], report.findings);

  // The runs list reads the relational row, not the file, so the headline number
  // has to move in both places or the two pages disagree about the same run.
  const row = getRun(run.runId);
  if (row) {
    finishRun({
      id: run.runId,
      status: row.status === "judging" ? "done" : row.status,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.score === null ? {} : { score: row.score }),
      autonomy,
      ...(row.error ? { error: row.error } : {}),
      endedAt: row.endedAt ?? Date.now(),
    });
  }

  return { report, autonomy };
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
  return judgeRun(run, readBrief(runId), opts);
}
