import OpenAI from "openai";
import { currentTrace, recordLlmCall } from "./trace";

// Model access for the engine's own calls (the director) and for the reference
// agent's tool loop. Everything goes through OpenRouter, which exposes an
// OpenAI-compatible API — so any model can be the agent under test by changing a
// slug, which is what makes the benchmark table possible at all.
//
// This mirrors apps/gmail's src/lib/eval/llm.ts for the same reason trace.ts does
// (a Next app is not importable from a workspace package), with one addition: the
// tracing transport also lifts `usage` out of the response, so cost and tokens
// land on the call that incurred them and the dashboard's cost figure can open
// its own per-call breakdown.
//
// Slugs use dots, not dashes: `anthropic/claude-haiku-4.5`, `openai/gpt-5.4`.

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** Override per-run with OPENROUTER_MODEL, or per-role at the call site. */
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

let client: OpenAI | null = null;

/**
 * The key, when the host supplies one instead of an environment variable.
 *
 * The engine is imported by a long-lived Next process as well as by the CLI, and
 * in that process the key is a row in platform.db that a user typed into the
 * Settings page — there is no environment variable to read, and there must not
 * be one, because writing a secret into `process.env` at runtime leaks it to
 * every other module in the process. So the host hands the key over explicitly
 * and this module keeps `process.env` as the fallback the CLI still uses.
 */
let configuredKey: string | null = null;

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * OpenRouter reports spend on the response body itself (`usage.cost`, in USD)
 * when the account has it enabled, and token counts always. Reading both here
 * means every role — director, agent — is metered at one seam, with no per-model
 * price table to keep in step with the provider.
 */
function usageOf(response: unknown): Pick<Parameters<typeof recordLlmCall>[0], "costUsd" | "tokens"> {
  const usage = (response as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return {};
  const prompt = num(usage.prompt_tokens) ?? 0;
  const completion = num(usage.completion_tokens) ?? 0;
  const cost = num(usage.cost);
  return {
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(prompt || completion ? { tokens: { prompt, completion } } : {}),
  };
}

/**
 * Transport that copies every request/response into the active trace. Recording
 * here rather than around `chat.completions.create` means every role is covered
 * at one seam, the bodies are captured verbatim (so `usage`, `finish_reason` and
 * any provider-specific reasoning field survive), and nothing breaks when the SDK
 * reshapes its methods.
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
    const response = parseJson(body);
    recordLlmCall({
      model,
      request,
      response,
      startedAt,
      endedAt: Date.now(),
      ...usageOf(response),
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

/**
 * Supply the key from somewhere other than the environment — a settings store,
 * a secret manager. Passing null clears it and returns to `process.env`.
 *
 * Dropping the memoized client is the whole point of doing this through a
 * function: the client captures its key at construction, so a key that changed
 * after the first model call would otherwise be ignored for the life of the
 * process, which in a dev server is "until someone restarts it".
 */
export function setApiKey(key: string | null): void {
  const next = key?.trim() || null;
  if (next === configuredKey) return;
  configuredKey = next;
  client = null;
}

/** The key that will be used, from the host first and the environment second. */
export function apiKey(): string | null {
  return configuredKey ?? process.env.OPENROUTER_API_KEY ?? null;
}

export function getClient(): OpenAI {
  if (!client) {
    const key = apiKey();
    if (!key) {
      throw new Error(
        "No OpenRouter key is set. Add one on the Settings page, or export OPENROUTER_API_KEY " +
          "(get a key at https://openrouter.ai/keys).",
      );
    }
    client = new OpenAI({
      apiKey: key,
      baseURL: OPENROUTER_BASE_URL,
      fetch: tracingFetch,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mglynnhenley/gmail-clone",
        // ASCII only: a header value is a ByteString, and an em dash here made
        // every model call in the run throw before it left the process.
        "X-Title": "Sonata Labs: episode engine",
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

const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/**
 * Ceiling on reasoning effort, from SONATA_MAX_EFFORT. High effort is most of the
 * wall clock on a run, so a cheap smoke pass wants to cap it without editing every
 * call site. Unset means each call keeps what it asked for; `none` drops reasoning
 * entirely.
 */
function cappedEffort(effort?: Effort): Effort | undefined {
  const cap = process.env.SONATA_MAX_EFFORT?.trim().toLowerCase();
  if (!cap) return effort;
  if (cap === "none") return undefined;
  if (!(cap in EFFORT_RANK)) return effort; // ignore a typo rather than fail the run
  if (!effort) return effort;
  return EFFORT_RANK[effort] <= EFFORT_RANK[cap as Effort] ? effort : (cap as Effort);
}

export function reasoningFor(effort?: Effort): Record<string, unknown> {
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

/** The seam the director is written against, so a test never needs a network. */
export type CompleteJSON = <T>(opts: CompleteJSONOptions) => Promise<T>;

/**
 * Structured completion. Uses OpenRouter's json_schema response format so the
 * response is valid against `schema`, with a tolerant parse as a safety net for
 * providers that only soft-honour it.
 *
 * `reasoning` is not universally safe alongside `response_format: json_schema`:
 * on some models it routes to a provider variant without structured-output
 * support and OpenRouter answers 200 with an error body and no choices. So an
 * empty first answer is retried once without reasoning rather than failing a run
 * twenty minutes in.
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
        json_schema: { name: opts.schemaName ?? "result", strict: true, schema: opts.schema },
      },
      ...reasoningFor(effort),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

  let res = await call(opts.effort);
  let text = res.choices?.[0]?.message?.content ?? "";

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

// ---------------------------------------------------------------------------
// The agent's seam. Tool calling, not structured output: the thing under test is
// whether a model chooses the right actions, so it has to be handed real tools
// and asked to pick.
// ---------------------------------------------------------------------------

export interface ChatOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

/** The seam the agent loop is written against, so a test never needs a network. */
export type ChatComplete = (opts: ChatOptions) => Promise<OpenAI.ChatCompletionMessage>;

/**
 * One assistant turn. Returns the message rather than the whole completion
 * because the loop only ever reads `content` and `tool_calls` — and because a
 * stub that has to fake a full `ChatCompletion` is a stub nobody writes correctly.
 */
export const chatComplete: ChatComplete = async (opts) => {
  const openai = getClient();
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await openai.chat.completions.create({
    model,
    max_tokens: opts.maxTokens ?? 4000,
    messages: opts.messages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...reasoningFor(opts.effort),
  } as OpenAI.ChatCompletionCreateParamsNonStreaming);

  const message = res.choices?.[0]?.message;
  if (!message) {
    throw new Error(
      `Empty response from ${model}${providerError(res) ? `: ${providerError(res)}` : ""}`,
    );
  }
  return message;
};

export { OpenAI };
