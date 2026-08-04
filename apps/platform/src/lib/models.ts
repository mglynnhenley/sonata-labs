// The curated model list. Pure data with no imports, so the settings page (a
// client component) and the server-side settings store can share one list.
//
// Slugs are OpenRouter ids — verified against https://openrouter.ai/api/v1/models.
// Prices are USD per million tokens, listed so choosing a model for a 32-tick
// day is a cost decision made with the numbers in view rather than afterwards.

export type ModelRole = "agent" | "director" | "judge";

export const MODEL_ROLES: readonly ModelRole[] = ["agent", "director", "judge"];

export const ROLE_LABELS: Record<ModelRole, string> = {
  agent: "Agent",
  director: "Director",
  judge: "Judge",
};

/** What each role does, in the user's language — shown under the select. */
export const ROLE_HINTS: Record<ModelRole, string> = {
  agent: "The model under test. It reads the day and does the work.",
  director: "Plays everyone else in the company. Writes their replies as the day runs.",
  judge: "Reads the finished day and names what went wrong. Worth a strong model.",
};

export interface ModelOption {
  /** OpenRouter slug. */
  id: string;
  label: string;
  vendor: string;
  /** USD per million prompt tokens. */
  inputUsd: number;
  /** USD per million completion tokens. */
  outputUsd: number;
  contextTokens: number;
  /** One line on when to pick it. */
  note: string;
}

export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    vendor: "Anthropic",
    inputUsd: 5,
    outputUsd: 25,
    contextTokens: 1_000_000,
    note: "Strongest agent in the benchmark. Slow and expensive over a full day.",
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    vendor: "Anthropic",
    inputUsd: 2,
    outputUsd: 10,
    contextTokens: 1_000_000,
    note: "The default judge: careful reader, a fifth of the price of Opus.",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    vendor: "Anthropic",
    inputUsd: 1,
    outputUsd: 5,
    contextTokens: 200_000,
    note: "Fast and cheap. Good director, good for a first look at a scenario.",
  },
  {
    id: "openai/gpt-5.4",
    label: "GPT-5.4",
    vendor: "OpenAI",
    inputUsd: 2.5,
    outputUsd: 15,
    contextTokens: 1_050_000,
    note: "Strong tool use; the usual comparison point for Opus.",
  },
  {
    id: "openai/gpt-5.2",
    label: "GPT-5.2",
    vendor: "OpenAI",
    inputUsd: 1.75,
    outputUsd: 14,
    contextTokens: 400_000,
    note: "Previous generation. Useful for showing movement between releases.",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    vendor: "Google",
    inputUsd: 2,
    outputUsd: 12,
    contextTokens: 1_048_576,
    note: "Long context; holds a whole simulated day without summarising.",
  },
  {
    id: "google/gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    vendor: "Google",
    inputUsd: 1.5,
    outputUsd: 9,
    contextTokens: 1_048_576,
    note: "Quick. A good director when the world has a lot of people in it.",
  },
  {
    id: "x-ai/grok-4.5",
    label: "Grok 4.5",
    vendor: "xAI",
    inputUsd: 2,
    outputUsd: 6,
    contextTokens: 500_000,
    note: "Cheap output, which matters for an agent that writes all day.",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    inputUsd: 0.44,
    outputUsd: 0.87,
    contextTokens: 1_048_576,
    note: "The value end of the table. Run the whole benchmark for pennies.",
  },
];

/** Cheap where it does not matter, careful where it does. */
export const DEFAULT_MODELS: Record<ModelRole, string> = {
  agent: "anthropic/claude-haiku-4.5",
  director: "anthropic/claude-haiku-4.5",
  judge: "anthropic/claude-sonnet-5",
};

export function findModel(id: string): ModelOption | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** `vendor/model-slug` — loose enough for any OpenRouter id not in the list. */
export const MODEL_ID = /^[a-z0-9-]+\/[a-zA-Z0-9._:-]+$/;

export function isModelId(value: string): boolean {
  return MODEL_ID.test(value);
}

/** "$2.50" / "$0.44" — always two significant places, never "2.5". */
export function usd(value: number): string {
  return `$${value < 1 ? value.toFixed(2) : value.toFixed(2).replace(/\.00$/, "")}`;
}

export function modelLabel(id: string): string {
  return findModel(id)?.label ?? id;
}
