import OpenAI from "openai";
import { currentTrace, recordLlmCall } from "./trace";

// Model access for the eval's own calls (profiling, generation, judging) and for
// the reference agent's tool loop. Everything goes through OpenRouter, which
// exposes an OpenAI-compatible API — so any model on OpenRouter can be used by
// changing a slug, no code change.
//
// Slugs use dots, not dashes: `anthropic/claude-opus-4.8`, `openai/gpt-5.4`.
// List them with: curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** Override per-run with OPENROUTER_MODEL, or per-role via runEval({models}). */
export const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL || "anthropic/claude-opus-4.8";

let client: OpenAI | null = null;

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Transport that copies every request/response into the active trace. Recording
 * here rather than around `chat.completions.create` means all four harness roles
 * are covered at one seam, the bodies are captured verbatim (so `usage`,
 * `finish_reason` and any provider-specific reasoning field survive), and nothing
 * breaks when the SDK reshapes its methods.
 */
const tracingFetch: typeof globalThis.fetch = async (input, init) => {
  if (!currentTrace()) return globalThis.fetch(input, init);

  const request = parseJson(typeof init?.body === "string" ? init.body : undefined);
  const model =
    request && typeof request === "object" && "model" in request
      ? String((request as { model: unknown }).model)
      : "";
  const startedAt = Date.now();

  try {
    const res = await globalThis.fetch(input, init);
    // Clone before reading: the SDK still needs to consume the original body.
    const body = await res.clone().text();
    recordLlmCall({
      model,
      request,
      response: parseJson(body),
      startedAt,
      endedAt: Date.now(),
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    });
    return res;
  } catch (err) {
    recordLlmCall({
      model,
      request,
      response: undefined,
      startedAt,
      endedAt: Date.now(),
      error: (err as Error).message,
    });
    throw err;
  }
};

export function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys and export it.",
      );
    }
    client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      fetch: tracingFetch,
      // Optional OpenRouter attribution headers.
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mglynnhenley/sonata-labs",
        "X-Title": "Gmail Sandbox Triage Eval",
      },
    });
  }
  return client;
}

/** Drop the memoized client. Tests use this to re-read env between cases. */
export function resetClient(): void {
  client = null;
}

export type Effort = "low" | "medium" | "high";

/**
 * OpenRouter's unified reasoning control. Not all providers accept `temperature`
 * (e.g. openai/gpt-5.4 rejects it), so we never send sampling params.
 *
 * `reasoning` is NOT universally safe to send alongside `response_format:
 * json_schema`: on some models it routes to a provider variant without structured
 * output support, and OpenRouter answers 200 with an `error` body and no choices —
 * e.g. anthropic/claude-haiku-4.5 returns "structured_outputs not supported in your
 * workspace." with reasoning set, and works perfectly without it. `completeJSON`
 * therefore retries once without reasoning rather than failing the run.
 */
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/**
 * Ceiling on reasoning effort, from EVAL_MAX_EFFORT. High effort is most of the
 * wall clock on a run — the generator's compose call and the judge both ask for it —
 * so a cheap smoke pass wants to cap it without editing every stage. Unset means
 * each call keeps whatever it asked for. `none` drops reasoning entirely.
 */
function cappedEffort(effort?: Effort): Effort | undefined {
  const cap = process.env.EVAL_MAX_EFFORT?.trim().toLowerCase();
  if (!cap) return effort;
  if (cap === "none") return undefined;
  if (!(cap in EFFORT_RANK)) return effort; // ignore a typo rather than fail the run
  if (!effort) return effort;
  return EFFORT_RANK[effort] <= EFFORT_RANK[cap as Effort] ? effort : (cap as Effort);
}

function reasoningFor(effort?: Effort): Record<string, unknown> {
  const capped = cappedEffort(effort);
  return capped ? { reasoning: { effort: capped } } : {};
}

/** OpenRouter can answer 200 with an error body instead of choices. */
function providerError(res: unknown): string | undefined {
  const e = (res as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof e === "string" ? e : undefined;
}

/** Strip markdown fences some models wrap JSON in, then parse. */
function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: grab the outermost JSON object.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error(`Model returned unparseable JSON: ${text.slice(0, 400)}`);
  }
}

export interface CompleteJSONOptions {
  system?: string;
  prompt: string;
  /**
   * JSON Schema. For strict structured outputs every object needs
   * `additionalProperties: false` and must list ALL properties in `required`.
   */
  schema: Record<string, unknown>;
  /** Schema name sent to the provider; must match /^[a-zA-Z0-9_-]+$/. */
  schemaName?: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * Structured completion. Uses OpenRouter's json_schema response format so the
 * response is valid against `schema`, with a tolerant parse as a safety net for
 * providers that only soft-honour it.
 */
export async function completeJSON<T>(opts: CompleteJSONOptions): Promise<T> {
  const openai = getClient();
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const model = opts.model ?? DEFAULT_MODEL;
  const call = (effort?: Effort) =>
    openai.chat.completions.create({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: opts.schemaName ?? "result",
          strict: true,
          schema: opts.schema,
        },
      },
      ...reasoningFor(effort),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

  let res = await call(opts.effort);
  let text = res.choices?.[0]?.message?.content ?? "";

  // Retry without reasoning when it produced nothing: on several cheaper models the
  // reasoning+json_schema combination is what fails, not the request itself. Without
  // this the whole harness is unusable on anything but the priciest tier.
  if (!text.trim() && opts.effort) {
    res = await call(undefined);
    text = res.choices?.[0]?.message?.content ?? "";
  }

  if (!text.trim()) {
    const choice = res.choices?.[0];
    // Surface the provider's own message — otherwise a real cause like
    // "structured_outputs not supported" is lost behind a bare finish_reason.
    throw new Error(
      `Empty response from ${model}` +
        `${providerError(res) ? `: ${providerError(res)}` : ""}` +
        ` (finish_reason=${choice?.finish_reason}).`,
    );
  }
  return parseJsonLoose<T>(text);
}

export { OpenAI };
