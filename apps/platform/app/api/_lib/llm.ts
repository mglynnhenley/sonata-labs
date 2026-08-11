// The dashboard's own model access: one JSON-shaped call, over OpenRouter, with
// no SDK. apps/gmail's eval stack has a richer client (tracing transport, cost
// accounting) but it is bound to that app's trace singleton and cannot be
// imported across app boundaries; the dashboard only ever needs "turn this
// description into one JSON object", so it asks with fetch and stays dependency-
// free. Anything that runs an agent belongs in the engine, not here.

import { modelCallError } from "@sonata/engine";
import { getApiKey } from "@/lib/settings";

export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Cheap by default: the seeder is prose generation, not reasoning. */
export const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5";

// The key comes from the same place the engine's does — the settings row a user
// typed on the Settings page, with the environment variable as the fallback.
// Reading `process.env` directly here was the reason a first-time user who pasted
// their key into Settings still had every generation fall back to a template: the
// key was saved, Settings said so, and this file could not see it. There is no
// environment variable to find in a UI-only install, which is the whole install
// the product asks a newcomer to do.
export function hasModelAccess(): boolean {
  return Boolean(getApiKey());
}

interface Choice {
  message?: { content?: string; reasoning?: string };
  /** "length" when the answer was cut off mid-JSON — the usual cause of an empty one. */
  finish_reason?: string;
  native_finish_reason?: string;
}

interface Completion {
  choices?: Choice[];
  error?: { message?: string };
}

/**
 * Pull the JSON object out of a completion that ignored the schema — some models
 * wrap it in prose or a fenced block. Brace-matching rather than a regex, since
 * scenario prose is full of braces-free but nested JSON.
 */
function extractObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("model returned no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("model returned an unterminated JSON object");
}

export interface CompleteJsonOptions {
  system: string;
  user: string;
  /** JSON Schema for the object wanted back. Sent as `json_schema` when supported. */
  schema: Record<string, unknown>;
  schemaName: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

async function post(body: unknown, signal?: AbortSignal): Promise<Completion> {
  const model = (body as { model?: string } | null)?.model ?? DEFAULT_MODEL;
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getApiKey() ?? ""}`,
      "x-title": "Sonata Labs",
    },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json()) as Completion;
  // Through the engine's translation, so a rejected or unfunded key reads the
  // same here as it does mid-run. OpenRouter's own 401 is "User not found.",
  // which arrives in the UI looking like a bug in the seeder.
  if (!res.ok) {
    throw modelCallError(
      Object.assign(new Error(json.error?.message ?? `OpenRouter HTTP ${res.status}`), {
        status: res.status,
      }),
      model,
    );
  }
  return json;
}

/**
 * One completion, parsed as JSON. Retries once without `response_format`, because
 * several models reject json_schema outright ("structured outputs not supported")
 * and would otherwise fail a generation that they can do perfectly well when
 * simply asked for JSON.
 */
export async function completeJson<T>(options: CompleteJsonOptions): Promise<T> {
  if (!hasModelAccess()) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — add it in Settings to generate a business from a description.",
    );
  }

  const base = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? 4000,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
  };

  /** The same ask with the schema in the prompt instead of in the protocol. */
  const askInProse = () =>
    post(
      {
        ...base,
        messages: [
          base.messages[0],
          {
            role: "user",
            content: `${options.user}\n\nReturn ONE JSON object matching this schema, and nothing else:\n${JSON.stringify(options.schema)}`,
          },
        ],
      },
      options.signal,
    );

  let completion: Completion;
  try {
    completion = await post(
      {
        ...base,
        response_format: {
          type: "json_schema",
          // Not strict: strict mode forbids optional properties, and a scenario
          // beat is optional-shaped by nature (an email has a subject, a Slack
          // post does not). The assembler validates instead.
          json_schema: { name: options.schemaName, strict: false, schema: options.schema },
        },
        // One model slug is served by several providers and not all of them
        // implement json_schema. Without this, whether a clone works is a
        // coin-flip on which one OpenRouter happened to pick.
        provider: { require_parameters: true },
      },
      options.signal,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/structured|json_schema|response_format|No endpoints/i.test(message)) throw err;
    completion = await askInProse();
  }

  // A provider that cannot do structured outputs does not always fail the
  // request: OpenRouter answers 200 with an error body and no choices, which
  // reads as "empty response" and used to end the clone right here. Same cause,
  // same remedy — ask again in prose.
  // Not for a truncated answer, which prose would only truncate again.
  const first = completion.choices?.[0];
  if (!first?.message?.content && first?.finish_reason !== "length") {
    completion = await askInProse();
  }

  const choice = completion.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // Name the cause: "empty response" alone sends the reader to the network tab
    // when the answer is nearly always a token budget or a provider-side refusal.
    const why =
      choice?.finish_reason === "length"
        ? `it ran out of tokens (max_tokens ${base.max_tokens}) before finishing the JSON`
        : (completion.error?.message ??
          `finish_reason=${choice?.finish_reason ?? "none"}${
            choice?.native_finish_reason ? `/${choice.native_finish_reason}` : ""
          }, no choices with content`);
    throw new Error(`${base.model} returned an empty response: ${why}`);
  }
  return JSON.parse(extractObject(content)) as T;
}
