import Anthropic from "@anthropic-ai/sdk";

// Thin wrapper over the Anthropic SDK for the eval's own model calls (profiling,
// generation, judging). The agent-under-test is separate — it talks to the
// sandbox through the googleapis SDK.

export const DEFAULT_MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        "No Anthropic credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login` " +
          "so the SDK can pick up a profile.",
      );
    }
    client = new Anthropic();
  }
  return client;
}

export type Effort = "low" | "medium" | "high";

export interface CompleteJSONOptions {
  system?: string;
  prompt: string;
  /** JSON Schema. Every object needs `additionalProperties: false` + `required`. */
  schema: Record<string, unknown>;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

/**
 * Structured completion: returns the model's response parsed and validated
 * against `schema` (via output_config.format, so malformed JSON can't come back).
 */
export async function completeJSON<T>(opts: CompleteJSONOptions): Promise<T> {
  const anthropic = getAnthropic();
  const res = await anthropic.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: opts.effort ?? "high",
      format: { type: "json_schema", schema: opts.schema },
    },
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: "user", content: opts.prompt }],
  });

  if (res.stop_reason === "refusal") {
    throw new Error("Anthropic API refused the request (stop_reason=refusal).");
  }

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) {
    throw new Error(`Empty response from model (stop_reason=${res.stop_reason}).`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Model returned unparseable JSON: ${text.slice(0, 400)}`);
  }
}

/** Plain text completion (used by the reference agent's tool loop). */
export { Anthropic };
