import {
  agentToolCalls,
  type ByTwin,
  type Criterion,
  type EpisodeJudgeInput,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type EpisodeSpec,
  type TwinDiff,
  type TwinSnapshot,
  TWIN_NAMES,
} from "@sonata/core";
import {
  diffAttio,
  diffCalendar,
  diffGmail,
  diffGoogleAds,
  diffGoogleDocs,
  diffLinkedIn,
  diffDesk,
  diffExcel,
  diffSlack,
} from "@sonata/engine";
import {
  escalationsFromTicks,
  judge,
  projectEpisode,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "@sonata/judge";
import { getSettings } from "@/lib/settings";
import { readTrace } from "../../../results/_lib/artifacts";
import { type JudgeSpend } from "./judgeAttempt";

// Project saved evidence into the one judge prompt, executed by an Inspect scorer.
const TIMEOUT_MS = 240_000;

/**
 * What the judge is told when the artifact never embedded its spec.
 *
 * Every run written since specs were embedded has one; the handful that predate it
 * still have a whole day in them worth reading, and a judge told plainly that the
 * brief is missing writes a weaker but honest report. Inventing a task here would
 * produce a confident report against a standard nobody set.
 */
const NO_BRIEF =
  "(the brief was not saved with this run — infer what the agent was for from the day " +
  "itself, and make that the first entry in `taskAmbiguities`)";

function diffOf(pair: { before: TwinSnapshot; after: TwinSnapshot }): TwinDiff | null {
  const { before, after } = pair;
  // Both snapshots come off one twin's adapter, so a mismatch is a corrupt
  // artifact rather than a case to handle — diffing across surfaces would
  // produce a change-log of the whole world appearing and disappearing.
  //
  // A surface missing from this list is worse than it looks: it produces no
  // diff, the judge is then told the surface was never captured, and a run whose
  // whole point was the CRM gets re-judged as a day nobody photographed. A
  // switch, so the next twin cannot be forgotten here quietly.
  switch (before.twin) {
    case "gmail":
      return after.twin === "gmail" ? diffGmail(before, after) : null;
    case "slack":
      return after.twin === "slack" ? diffSlack(before, after) : null;
    case "calendar":
      return after.twin === "calendar" ? diffCalendar(before, after) : null;
    case "attio":
      return after.twin === "attio" ? diffAttio(before, after) : null;
    case "google-docs":
      return after.twin === "google-docs" ? diffGoogleDocs(before, after) : null;
    case "google-ads":
      return after.twin === "google-ads" ? diffGoogleAds(before, after) : null;
    case "linkedin":
      return after.twin === "linkedin" ? diffLinkedIn(before, after) : null;
    case "excel":
      return after.twin === "excel" ? diffExcel(before, after) : null;
    case "desk":
      return after.twin === "desk" ? diffDesk(before, after) : null;
  }
}

/**
 * The per-twin change-logs, re-derived rather than stored.
 *
 * The adapters' `diff` functions are pure, so this is the same answer the engine
 * would have computed at the close of the day — which is exactly what makes an old
 * artifact re-judgeable: nothing here needs the twin that produced it to still exist.
 */
function diffsOf(snapshots: EpisodeRun["snapshots"]): ByTwin<TwinDiff> {
  const out: ByTwin<TwinDiff> = {};
  for (const name of TWIN_NAMES) {
    const pair = snapshots[name];
    if (!pair?.before || !pair.after) continue;
    const diff = diffOf(pair);
    // Filed under the diff's own tag rather than the key it was found at: the two
    // agree on every artifact the engine writes, and where they would not, the
    // diff is the one that knows what it actually compared.
    if (diff) out[diff.twin] = diff;
  }
  return out;
}

/**
 * The criteria no checker could settle, which reach the judge as questions.
 *
 * Re-derived from the artifact for the same reason the checklist is: the stored
 * rows are results, and which criteria were DEFERRED is not a result — a `judged`
 * criterion leaves no row at all, so it is invisible in the saved verdict and
 * would silently stop being asked.
 */
function deferredOf(spec: EpisodeSpec | null, run: EpisodeRun): Criterion[] {
  if (!spec?.world || !spec.success?.checklist?.length) return [];
  try {
    return runChecklist({
      criteria: spec.success.checklist,
      world: spec.world,
      beats: spec.beats,
      refs: refsFromTicks(run.ticks),
      snapshots: run.snapshots,
      audit: run.audit ?? [],
      escalations: escalationsFromTicks(run.ticks),
      written: writtenFromTicks(run.ticks),
      agentActed: agentToolCalls(run.ticks) > 0,
      tickOf: tickIndexer(run.ticks),
    }).deferred;
  } catch {
    // A malformed spec must cost the judge its extra questions, not the run its
    // diagnosis. The checklist results it already has are unaffected.
    return [];
  }
}

/**
 * The day, read off disk into the one object the judge takes.
 *
 * Exported for the same reason `buildEpisodePrompt` is pure: the prompt a run
 * would be judged with can be built, measured and diffed without spending
 * anything on a model.
 */
export function buildJudgeInput(run: EpisodeRun, spec: EpisodeSpec | null): EpisodeJudgeInput {
  // The closing summary lives on the trace and nowhere else, and it is judged
  // evidence in its own right — a summary that overstates the day is a finding.
  const agentSummary = readTrace(run.runId)?.agentSummary;

  return projectEpisode({
    spec: {
      id: spec?.id ?? run.specId,
      task: spec?.task ?? NO_BRIEF,
      story: spec?.story ?? "(no story was saved with this run)",
      success: spec?.success ?? { checklist: [], judgeQuestions: [] },
      // The clock and the beats are what date the day: the end state is narrowed
      // to the day the run SIMULATED, and truncation is measured against the
      // beats that were scheduled. Both degrade to a sane default without them.
      ...(spec?.clock ? { clock: spec.clock } : {}),
      ...(spec?.beats ? { beats: spec.beats } : {}),
      ...(spec?.termination ? { termination: spec.termination } : {}),
    },
    run,
    diffs: diffsOf(run.snapshots),
    checklist: run.verdict?.checklist ?? [],
    deferred: deferredOf(spec, run),
    ...(agentSummary?.trim() ? { agentSummary } : {}),
  });
}

import { inspectCompletion } from "@/lib/engine/inspectJudge";
import type { Assessment } from "@/lib/engine/assessments";

export interface RejudgeOptions {
  assessment: Assessment;
  model?: string;
  signal?: AbortSignal;
  /** Told what the pass cost as soon as the provider says, success or not. */
  onSpend?: (spend: JudgeSpend) => void;
}

/**
 * Which model will read the day.
 *
 * Falls back to the judge model chosen in Settings, so a bare POST with no body
 * re-judges with whatever the dashboard would have used anyway. Exported because
 * the attempt is recorded before the call goes out, and a record that could not
 * name the model would be no use to the person asking why it failed.
 */
export function judgeModelFor(model?: string): string {
  return model?.trim() || getSettings().models.judge;
}

export async function rejudgeRun(
  run: EpisodeRun,
  spec: EpisodeSpec | null,
  opts: RejudgeOptions,
): Promise<EpisodeJudgeReport> {
  const model = judgeModelFor(opts.model);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) controller.abort();

  try {
    return await judge(buildJudgeInput(run, spec), {
      complete: inspectCompletion(opts.assessment, controller.signal, opts.onSpend ?? (() => undefined)),
      model,
    });
  } catch (err) {
    // "This operation was aborted" is what the platform says; it tells the reader
    // nothing about which of the two clocks ran out.
    if (timedOut) {
      throw new Error(
        `${model} was still reading this day after ${Math.round(TIMEOUT_MS / 60_000)} minutes, so the ` +
          "call was given up on. A faster judge model, or a shorter day, gets through.",
      );
    }
    if ((err as Error).name === "AbortError") {
      throw new Error("The judge call was stopped before it answered, so nothing came back.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}
