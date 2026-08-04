import type { AgentTrace, LlmCall, RunCost, TraceRole } from "@sonata/core";

// Cost, opened up. The verdict carries one total; the trace carries every call
// that made it. This turns the second into the first, keeping the chain visible
// all the way down — a dollar figure on the results page has to be able to name
// the calls it is the sum of.
//
// The trace holds verbatim provider bodies and runs to megabytes, so this is
// server-side: the page ships these projections to the browser, never the trace.

export interface CallLine {
  seq: number;
  role: TraceRole;
  model: string;
  tick: number | null;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  ms: number;
  error?: string;
  /** The last thing we asked it, trimmed. */
  ask: string;
  /** What it said back, trimmed. Empty for a call that only returned tool calls. */
  said: string;
}

export interface RoleCost {
  role: TraceRole;
  calls: number;
  /** How many of them carried a price. Below `calls`, the sum is a floor. */
  pricedCalls: number;
  /** Null when no call in the role reported a price — never a misleading 0. */
  costUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  models: string[];
  lines: CallLine[];
}

export interface CostReport {
  roles: RoleCost[];
  /** Summed from the calls; null when no call reported a price. */
  totalUsd: number | null;
  /** What the run artifact itself claims. Shown when the calls cannot be summed. */
  declaredUsd: number | null;
  calls: number;
  pricedCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** False when there is no trace on disk — the breakdown degrades to the total. */
  hasPerCall: boolean;
  /** Every call in the trace carried a price, so `totalUsd` is the whole bill. */
  complete: boolean;
}

/**
 * The one figure to print big.
 *
 * The per-call sum is the better number *only when every call carried a price*.
 * Providers routinely omit cost on some responses, and summing what is left
 * would quietly under-report the day — a confident wrong number, which is worse
 * than a coarse right one. So a partial trace defers to what the run itself
 * recorded, and the breakdown below says how much of it is accounted for.
 */
export function headlineUsd(cost: CostReport): number | null {
  if (cost.complete && cost.totalUsd !== null) return cost.totalUsd;
  return cost.declaredUsd ?? cost.totalUsd;
}

/** Enough of an OpenAI-shaped body to read usage and the text of a turn. */
interface ChatBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function asBody(value: unknown): ChatBody | null {
  return typeof value === "object" && value !== null ? (value as ChatBody) : null;
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Content can be a string or the parts array vision-style models take. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join(" ");
}

function askOf(call: LlmCall): string {
  const messages = asBody(call.request)?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOf(messages[i]?.content);
    if (text.trim()) return trim(text, 320);
  }
  return "";
}

function saidOf(call: LlmCall): string {
  const content = asBody(call.response)?.choices?.[0]?.message?.content;
  return content ? trim(content, 320) : "";
}

function tokensOf(call: LlmCall): { prompt: number | null; completion: number | null } {
  if (call.tokens) return { prompt: call.tokens.prompt, completion: call.tokens.completion };
  const usage = asBody(call.response)?.usage;
  return {
    prompt: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completion: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
  };
}

/** Agent first: it is the thing under test, and usually the bulk of the bill. */
const ROLE_ORDER: readonly TraceRole[] = [
  "agent",
  "director",
  "judge",
  "world",
  "generator",
  "profiler",
];

function toLine(call: LlmCall): CallLine {
  const tokens = tokensOf(call);
  return {
    seq: call.seq,
    role: call.role,
    model: call.model || "unknown model",
    tick: typeof call.tick === "number" ? call.tick : null,
    costUsd: typeof call.costUsd === "number" ? call.costUsd : null,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    ms: Math.max(0, (call.endedAt || 0) - (call.startedAt || 0)),
    ...(call.error ? { error: call.error } : {}),
    ask: askOf(call),
    said: saidOf(call),
  };
}

export function costBreakdown(trace: AgentTrace | null, declared: RunCost | null): CostReport {
  const calls = (trace?.llmCalls ?? []).map(toLine).sort((a, b) => a.seq - b.seq);

  const byRole = new Map<TraceRole, CallLine[]>();
  for (const line of calls) {
    const bucket = byRole.get(line.role);
    if (bucket) bucket.push(line);
    else byRole.set(line.role, [line]);
  }

  const roles: RoleCost[] = [...byRole.entries()]
    .map(([role, lines]) => {
      const priced = lines.filter((l) => l.costUsd !== null);
      return {
        role,
        calls: lines.length,
        pricedCalls: priced.length,
        costUsd: priced.length ? priced.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) : null,
        promptTokens: lines.reduce((sum, l) => sum + (l.promptTokens ?? 0), 0),
        completionTokens: lines.reduce((sum, l) => sum + (l.completionTokens ?? 0), 0),
        ms: lines.reduce((sum, l) => sum + l.ms, 0),
        models: [...new Set(lines.map((l) => l.model))],
        lines,
      };
    })
    .sort((a, b) => {
      const rank = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
      return rank !== 0 ? rank : (b.costUsd ?? 0) - (a.costUsd ?? 0);
    });

  const pricedRoles = roles.filter((r) => r.costUsd !== null);
  const pricedCalls = roles.reduce((sum, r) => sum + r.pricedCalls, 0);

  return {
    roles,
    totalUsd: pricedRoles.length
      ? pricedRoles.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      : null,
    declaredUsd: declared ? declared.usd : null,
    calls: calls.length || (declared?.llmCalls ?? 0),
    pricedCalls,
    promptTokens:
      roles.reduce((sum, r) => sum + r.promptTokens, 0) || (declared?.promptTokens ?? 0),
    completionTokens:
      roles.reduce((sum, r) => sum + r.completionTokens, 0) || (declared?.completionTokens ?? 0),
    hasPerCall: calls.length > 0,
    complete: calls.length > 0 && pricedCalls === calls.length,
  };
}

export const ROLE_LABELS: Record<TraceRole, string> = {
  agent: "The agent",
  director: "The world answering",
  judge: "The judge",
  world: "World generation",
  generator: "Scenario generation",
  profiler: "Profiling",
};
