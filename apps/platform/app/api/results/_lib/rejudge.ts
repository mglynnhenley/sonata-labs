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
import { recordJudgeCall, type JudgeSpend } from "./judgeAttempt";

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

/**
 * A judge pass reasons for a long time before it writes; this is not a small answer.
 *
 * It was 16k, and at 16k the two most expensive real runs in this repo both paid
 * for a full pass and got nothing back: one `finish_reason=length` with an empty
 * body, one with JSON severed mid-sentence. A reasoning model spends this budget
 * on thinking before it spends any of it on the report, so the ceiling has to
 * clear both. Nothing is billed for room that goes unused; a truncated answer is
 * billed in full and is worth zero.
 */
const MAX_TOKENS = 48_000;

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
  /** OpenRouter prices the call on the body itself, in USD. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function spendOf(body: ChatCompletion | null): JudgeSpend {
  return {
    usd: num(body?.usage?.cost),
    promptTokens: num(body?.usage?.prompt_tokens) ?? 0,
    completionTokens: num(body?.usage?.completion_tokens) ?? 0,
  };
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
 *
 * It meters itself. The engine's transport lifts `usage` off every call it makes
 * (see `packages/engine/src/llm.ts`); this one is outside that seam, so it does
 * the same job here — the call goes onto the run's trace as a `judge` call, and
 * `onSpend` fires the moment the body is read, BEFORE it is parsed. A pass that
 * answers with truncated JSON was paid for exactly like one that answered well,
 * and the run has to be able to say so.
 */
function openRouter(runId: string, signal: AbortSignal, onSpend: (spend: JudgeSpend) => void) {
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
    const buildRequest = (maxTokens: number) => ({
      model,
      max_tokens: maxTokens,
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
      // Ask for the price explicitly rather than relying on the account default:
      // an unpriced judge call would show up as a blank in the run's own bill.
      usage: { include: true },
      // No `reasoning` field, deliberately. Left off, a model that thinks by
      // default still thinks — and that alone was expensive enough: the one
      // Sonnet 5 pass that got through wrote 18.8k completion tokens for a 1.5k
      // report and took 231 of the 240 seconds allowed, while two earlier ones
      // spent the whole ceiling thinking and answered with nothing. Adding a
      // request for more here is how this feature goes dark again.
    });

    const send = async (maxTokens: number) => {
      const request = buildRequest(maxTokens);
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "X-Title": "Sonata Labs",
          },
          body: JSON.stringify(request),
        });
      } catch (err) {
        // Nothing came back, so nothing was billed — but the attempt is still
        // part of the day's record, exactly as a failed agent call is.
        recordJudgeCall(runId, {
          model,
          request,
          response: undefined,
          startedAt,
          endedAt: Date.now(),
          error: (err as Error).message,
        });
        throw err;
      }

      const body = (await res.json().catch(() => null)) as ChatCompletion | null;
      const spend = spendOf(body);
      onSpend(spend);
      // Only what a model actually did goes on the trace. A request the gateway
      // turned away — no credit, bad slug — ran nothing and was billed nothing,
      // and filing it here would put an unpriced call in the ledger, which is how
      // the whole day's total stops being trustworthy: `costBreakdown` can no
      // longer say every call carried a price, so it falls back to the figure the
      // run closed with, which is the one figure that excludes the judge. The
      // refusal is not lost — it is the reason on the attempt record.
      const billed = res.ok || spend.usd !== null || spend.promptTokens > 0;
      if (billed) {
        recordJudgeCall(runId, {
          model,
          request,
          response: body,
          startedAt,
          endedAt: Date.now(),
          ...(spend.usd === null ? {} : { costUsd: spend.usd }),
          ...(spend.promptTokens || spend.completionTokens
            ? { tokens: { prompt: spend.promptTokens, completion: spend.completionTokens } }
            : {}),
          ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
        });
      }
      return { res, body, maxTokens };
    };

    let sent = await send(opts.maxTokens ?? MAX_TOKENS);
    // A ceiling is RESERVED against the key's remaining credit, not billed — so a
    // key with a few dollars left refuses a request it could easily have paid
    // for, and the whole judging feature goes dark rather than degrading. The
    // provider says in the refusal exactly what it will allow; take it. A cramped
    // pass that gets cut off says so plainly below, which is a better answer than
    // no pass at all.
    const affordable = affordableTokens(sent.res, sent.body);
    if (affordable !== null && affordable < sent.maxTokens) {
      sent = await send(affordable);
    }

    const { res, body, maxTokens } = sent;
    if (!res.ok) {
      throw new Error(body?.error?.message || `${model} refused the request (HTTP ${res.status}).`);
    }
    // OpenRouter can answer 200 with an error body instead of choices.
    const text = body?.choices?.[0]?.message?.content ?? "";
    // Said in full, because it is shown to the person deciding what to do next:
    // running out of room is fixed by a bigger ceiling or a terser model, and it
    // reads nothing like a refusal or a bad key.
    if (body?.choices?.[0]?.finish_reason === "length") {
      throw new Error(
        `${model} ran out of room: it used all ${maxTokens.toLocaleString()} tokens it was allowed ` +
          `and its answer was cut off${text.trim() ? " mid-sentence" : " before it wrote anything"}, ` +
          "so there is no report to read. A shorter-winded judge model, or a smaller day, gets through" +
          (maxTokens < MAX_TOKENS
            ? " — and this pass was already capped short by the credit left on the key."
            : "."),
      );
    }
    if (!text.trim()) {
      throw new Error(
        body?.error?.message ||
          `${model} returned nothing (finish_reason=${body?.choices?.[0]?.finish_reason ?? "unknown"}).`,
      );
    }
    return parseJsonLoose<T>(text);
  };
}

/**
 * The ceiling the key can actually reserve, read off the provider's own refusal.
 *
 * Parsing a message is not something to do lightly, and this one is narrow on
 * purpose: it only fires on the payment status, and anything it does not
 * recognise leaves the original refusal to be reported as-is. The alternative is
 * a judge that stops working entirely whenever the key runs low, which is the
 * moment a benchmark's owner most needs to know what their day was worth.
 */
function affordableTokens(res: Response, body: ChatCompletion | null): number | null {
  if (res.status !== 402) return null;
  const match = /can only afford ([\d,]+)/i.exec(body?.error?.message ?? "");
  if (!match) return null;
  const affordable = Number(match[1].replace(/,/g, ""));
  // Below this there is no room for a report worth reading, and a pass that is
  // certain to be cut off is not worth paying for.
  return Number.isFinite(affordable) && affordable >= 4000 ? affordable : null;
}

export interface RejudgeOptions {
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
  opts: RejudgeOptions = {},
): Promise<EpisodeJudgeReport> {
  const model = judgeModelFor(opts.model);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => controller.abort());

  try {
    return await judge(buildJudgeInput(run, spec), {
      complete: openRouter(run.runId, controller.signal, opts.onSpend ?? (() => undefined)),
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
  }
}
