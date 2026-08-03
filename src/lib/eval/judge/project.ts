import type { RunTrace, ToolCall } from "../trace";
import type { JudgeTrace } from "./types";

// Shrink a run trace to the part a judge can actually reason about.
//
// The `.trace.json` artifacts in data/eval-runs/ run 0.6–1.3 MB, because every
// `llmCalls` entry holds the verbatim OpenRouter request body — and that body
// carries the whole conversation so far, so the message array is re-serialized
// in full on every turn. Handing that to the judge would blow its context long
// before it read a single finding, and `completeJSON`'s `maxTokens` caps output,
// not input. This is the only path by which a trace reaches the judge.
//
// What survives: what the agent did (tool calls, with results summarized to a
// line) and what it said about it (assistant prose, no request echo). What goes:
// every request body, every tool payload, every token-usage block.

/** Cap on a projected tool result. Past this a result is a payload, not a signal. */
const MAX_SUMMARY = 300;

/** Cap on one turn of agent prose — a few paragraphs of reasoning, no more. */
const MAX_TURN = 2000;

/** Unknown tools get raw JSON, kept short: nothing here knows what matters in it. */
const MAX_UNKNOWN = 200;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Tool results are `unknown` and shaped by whatever the SDK returned. */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** `JSON.stringify` is typed `string` but returns undefined for undefined input. */
function json(v: unknown): string {
  const s = JSON.stringify(v);
  return typeof s === "string" ? s : String(v);
}

const MUTATION_VERB: Record<string, string> = {
  create_label: "created label",
  modify_labels: "modified labels on",
  archive: "archived",
  trash: "trashed",
  send_reply: "sent reply on",
  reply_all: "sent reply-all on",
  forward: "forwarded",
  create_draft: "drafted reply on",
};

/**
 * A mutation's confirmation. The returned id proves the write landed and is what
 * a finding cites; `labelIds` is the post-state, which is the only way to tell a
 * star from an archive after the fact. The rest of the response is echoed input.
 */
function confirmation(name: string, r: Record<string, unknown>): string {
  const verb = MUTATION_VERB[name] ?? name;
  const id = text(r.id) || text(r.draftId) || text(r.messageId);
  const head = id ? `${verb} ${id}` : verb;

  const attrs: string[] = [];
  if (text(r.name)) attrs.push(`name "${text(r.name)}"`);
  const labels = strings(r.labelIds);
  if (labels.length) attrs.push(`labels: ${labels.join(", ")}`);
  const threadId = text(r.threadId);
  if (threadId && threadId !== id) attrs.push(`thread ${threadId}`);

  return attrs.length ? `${head} — ${attrs.join(", ")}` : head;
}

/**
 * One line per tool call. Reads collapse to their shape — a count, a subject, a
 * sender — because the judge needs to know *that* the agent looked and at what,
 * while the bodies it read are already visible through the mailbox diff.
 */
function summarize(call: ToolCall): string {
  // A failed call wrote nothing and returned nothing worth reading.
  if (call.error) return truncate(`error: ${call.error}`, MAX_SUMMARY);

  // Some failures arrive in the payload rather than as a throw — the sandbox
  // answers a duplicate create_label with `{error}` and a 200. Without this the
  // summary reads "created label" with no id, and the judge scores a write that
  // never happened.
  const r = obj(call.result);
  if (text(r.error)) return truncate(`error: ${text(r.error)}`, MAX_SUMMARY);

  switch (call.name) {
    case "list_messages":
      return `${count(r.messages)} messages`;
    case "get_thread": {
      const first = obj(Array.isArray(r.messages) ? r.messages[0] : undefined);
      const n = count(r.messages);
      return truncate(
        `thread ${text(r.threadId)}: ${n} messages, subject "${text(first.subject)}"`,
        MAX_SUMMARY,
      );
    }
    case "get_message":
      return truncate(`from ${text(r.from)} — subject "${text(r.subject)}"`, MAX_SUMMARY);
    case "list_labels":
      return `${count(r.labels)} labels`;
    case "create_label":
    case "modify_labels":
    case "archive":
    case "trash":
    case "send_reply":
    case "reply_all":
    case "forward":
    case "create_draft":
      return truncate(confirmation(call.name, r), MAX_SUMMARY);
    default:
      // A tool this file has never heard of — a custom agent's, or one added
      // since. Better a clipped blob than nothing.
      return truncate(json(call.result), MAX_UNKNOWN);
  }
}

/** Minimal view of an OpenAI-shaped completion, matching `TracePanel.assistantTurn`. */
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * The prose half of an assistant turn. `response` is whatever the provider sent,
 * which on a bad turn is an error body with none of these fields — hence the
 * `typeof` guard rather than `content?.trim()`, which would throw on a number.
 */
function turnText(response: unknown): string {
  const content = (response as ChatResponse | undefined)?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

export function projectTrace(trace: RunTrace): JudgeTrace {
  const steps = [...trace.toolCalls]
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({
      seq: c.seq,
      name: c.name,
      args: c.args,
      resultSummary: summarize(c),
      isMutation: c.isMutation,
      ...(c.error ? { error: c.error } : {}),
    }));

  // Only the agent's own turns: the harness's profiler/generator/judge calls are
  // the scaffolding that built the run, not behaviour under test.
  const turns = trace.llmCalls
    .filter((c) => c.role === "agent")
    .map((c) => ({ seq: c.seq, text: truncate(turnText(c.response), MAX_TURN) }))
    .filter((t) => t.text.length > 0);

  return { steps, turns, agentSummary: trace.agentSummary };
}
