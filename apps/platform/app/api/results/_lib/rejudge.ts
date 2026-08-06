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
import { diffCalendar, diffGmail, diffSlack } from "@sonata/engine";
import {
  escalationsFromTicks,
  judge,
  projectEpisode,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "@sonata/judge";
import { getApiKey, getSettings } from "@/lib/settings";
import { readTrace } from "../../../results/_lib/artifacts";

// The offline re-judge. A finished run carries the whole day — every beat, every
// step, both snapshots of every twin — so it can be read again by a different
// model months later with nothing live attached. That promise is the reason the
// artifact is shaped the way it is, and this is the code that cashes it in.
//
// THE PROMPT IS NOT BUILT HERE. It is `@sonata/judge`'s `buildEpisodePrompt`, and
// this file is now only the two things that package deliberately does not own: the
// HTTP call, and reading the day off disk into `EpisodeJudgeInput`.
//
// It used to own a second prompt of its own, and that is worth recording because
// the failure was invisible from either side. `@sonata/judge` grew the per-surface
// diffs, then the sampling that says how much of a day reached the model, then the
// end state — and none of it ever reached a model, because every judging path in
// the product (the engine at the close of a run, `sonata judge`, and the Re-judge
// button) came through here, into a prompt that had none of them and capped the
// day at 150 steps with `slice`. Both halves typechecked and both halves were
// tested. One was simply dead. There is one judge prompt in this product; this is
// the file that has to keep it that way.

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** A judge pass reasons for a long time before it writes; this is not a small answer. */
const MAX_TOKENS = 16_000;

/** Beyond this the request is hung, not slow. Matches the route's `maxDuration`. */
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
  "itself, and say in `taskUnderstanding` that you had to)";

function diffOf(pair: { before: TwinSnapshot; after: TwinSnapshot }): TwinDiff | null {
  const { before, after } = pair;
  // Both snapshots come off one twin's adapter, so a mismatch is a corrupt
  // artifact rather than a case to handle — diffing across surfaces would
  // produce a change-log of the whole world appearing and disappearing.
  if (before.twin === "gmail" && after.twin === "gmail") return diffGmail(before, after);
  if (before.twin === "slack" && after.twin === "slack") return diffSlack(before, after);
  if (before.twin === "calendar" && after.twin === "calendar") return diffCalendar(before, after);
  return null;
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
    if (diff?.twin === "gmail") out.gmail = diff;
    else if (diff?.twin === "slack") out.slack = diff;
    else if (diff?.twin === "calendar") out.calendar = diff;
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

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  error?: { message?: string };
}

/** Strip the markdown fence some models wrap JSON in, then parse. */
function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`The judge returned unparseable JSON: ${cleaned.slice(0, 300)}`);
  }
}

/**
 * `@sonata/judge`'s structured-completion port, over OpenRouter.
 *
 * Plain `fetch` rather than the OpenAI SDK: the dashboard has no model dependency
 * of its own, and a judge pass is one request — carrying a client library for it
 * would be the tail wagging the dog.
 */
function openRouter(signal: AbortSignal) {
  return async function complete<T>(opts: {
    system?: string;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName?: string;
    model?: string;
    maxTokens?: number;
  }): Promise<T> {
    // Through the settings store, not the environment: a key typed into Settings
    // lives in platform.db, and reading only `process.env` here is how re-judging
    // ends up the one feature that claims there is no key when there plainly is.
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error(
        "No OpenRouter key is set, so no model can be reached. Add one on the Settings page, or " +
          "put OPENROUTER_API_KEY in this machine's environment.",
      );
    }

    const model = opts.model ?? getSettings().models.judge;
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-Title": "Sonata Labs",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? MAX_TOKENS,
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: opts.prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: opts.schemaName ?? "episode_judge_report",
            strict: true,
            schema: opts.schema,
          },
        },
      }),
    });

    const body = (await res.json().catch(() => null)) as ChatCompletion | null;
    if (!res.ok) {
      throw new Error(body?.error?.message || `${model} refused the request (HTTP ${res.status}).`);
    }
    // OpenRouter can answer 200 with an error body instead of choices.
    const text = body?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new Error(
        body?.error?.message ||
          `${model} returned nothing (finish_reason=${body?.choices?.[0]?.finish_reason ?? "unknown"}).`,
      );
    }
    return parseJsonLoose<T>(text);
  };
}

export interface RejudgeOptions {
  model?: string;
  signal?: AbortSignal;
}

export async function rejudgeRun(
  run: EpisodeRun,
  spec: EpisodeSpec | null,
  opts: RejudgeOptions = {},
): Promise<EpisodeJudgeReport> {
  // Falls back to the judge model chosen in Settings, so a bare POST with no
  // body re-judges with whatever the dashboard would have used anyway.
  const model = opts.model?.trim() || getSettings().models.judge;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => controller.abort());

  try {
    return await judge(buildJudgeInput(run, spec), {
      complete: openRouter(controller.signal),
      model,
      effort: "high",
    });
  } finally {
    clearTimeout(timer);
  }
}
