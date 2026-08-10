import OpenAI from "openai";

// Model access for world generation, on the same wire contract as the Gmail
// eval's `apps/gmail/src/lib/eval/llm.ts`: OpenRouter, strict json_schema
// structured output, no sampling params (gpt-5.4 rejects `temperature`), and a
// tolerant parse for providers that only soft-honour the schema.
//
// This is a second, dependency-free copy rather than an import because a package
// may not depend on an app. The seam that matters is `CompleteJSON`:
// `generateWorld` takes one, so the episode engine can hand in the eval stack's
// trace-recording version and get every generation call on the run trace.

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** Override per-run with OPENROUTER_MODEL. */
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-opus-4.8";

export type Effort = "low" | "medium" | "high";

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

/** The one seam between this package and any model. */
export type CompleteJSON = <T>(opts: CompleteJSONOptions) => Promise<T>;

let client: OpenAI | null = null;

function getClient(): OpenAI {
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
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mglynnhenley/sonata-labs",
        "X-Title": "Sonata Labs World Seeder",
      },
    });
  }
  return client;
}

/** Drop the memoized client. Tests use this to re-read env between cases. */
export function resetClient(): void {
  client = null;
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
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Model returned unparseable JSON: ${text.slice(0, 400)}`);
  }
}

/** OpenRouter can answer 200 with an error body instead of choices. */
function providerError(res: unknown): string | undefined {
  const e = (res as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof e === "string" ? e : undefined;
}

export const completeJSON: CompleteJSON = async <T>(opts: CompleteJSONOptions): Promise<T> => {
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
      ...(effort ? { reasoning: { effort } } : {}),
      // One model slug can be served by several providers, and not all of them
      // implement structured outputs — a live run of this pipeline had the same
      // haiku request answered by Anthropic (fine) and then by a provider that
      // returned 200 with "structured_outputs not supported in your workspace"
      // and no choices. `require_parameters` makes OpenRouter route only to
      // providers that honour every parameter sent, which turns a coin-flip
      // failure into a deterministic one.
      provider: { require_parameters: true },
    } as OpenAI.ChatCompletionCreateParamsNonStreaming);

  type Answer = Awaited<ReturnType<typeof call>>;
  let res: Answer | undefined;
  let text = "";
  let firstError: string | undefined;

  if (opts.effort) {
    // Reasoning narrows the provider set further, and on some models it is the
    // combination with json_schema that fails rather than either alone. Both the
    // empty answer and the outright rejection get one retry without it, because
    // "your clone failed" is a far worse outcome than a slightly dumber pass.
    try {
      res = await call(opts.effort);
      text = res.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) firstError = providerError(res);
    } catch (err) {
      firstError = (err as Error).message;
    }
  }

  if (!text.trim()) {
    res = await call(undefined);
    text = res.choices?.[0]?.message?.content ?? "";
  }

  if (!text.trim()) {
    const detail = providerError(res) ?? firstError;
    throw new Error(
      `Empty response from ${model}${detail ? `: ${detail}` : ""}` +
        ` (finish_reason=${res?.choices?.[0]?.finish_reason}).`,
    );
  }
  return parseJsonLoose<T>(text);
};
