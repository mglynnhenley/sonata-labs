import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionRow } from "../audit";

// Capture of everything the harness asked a model to do, and everything the agent
// under test did with the mailbox.
//
// Capture is *ambient*: it hangs off AsyncLocalStorage rather than a parameter, so
// no signature in the harness changes to opt in — `TriageAgent.triage()` still
// returns `Promise<void>`, and a custom agent gets traced without knowing traces
// exist. Outside a `withTrace` scope every hook here is a no-op, which is what
// keeps the zero-model-call paths (eval:check, unit tests) untouched.

/** Which stage of the harness made a model call. */
export type TraceRole = "profiler" | "generator" | "judge" | "agent";

export interface LlmCall {
  seq: number;
  role: TraceRole;
  model: string;
  /** Verbatim JSON bodies, so the trace survives provider/SDK changes. */
  request: unknown;
  response: unknown;
  startedAt: number;
  endedAt: number;
  error?: string;
}

export interface ToolCall {
  seq: number;
  name: string;
  args: unknown;
  result: unknown;
  /** True for tools that change the mailbox, and so leave audit rows behind. */
  isMutation: boolean;
  startedAt: number;
  endedAt: number;
  /** Set when the call threw or the sandbox rejected it; such calls log nothing. */
  error?: string;
  /** Audit rows attributed to this call by `attributeActions`. */
  actionIds: number[];
  /** What the call acted on, for jumping the UI to it. */
  threadId?: string;
  messageId?: string;
}

export interface RunTrace {
  runId: string;
  llmCalls: LlmCall[];
  toolCalls: ToolCall[];
  /** The agent's closing account of its own triage, which the loop otherwise drops. */
  agentSummary?: string;
}

export function newTrace(runId: string): RunTrace {
  return { runId, llmCalls: [], toolCalls: [] };
}

interface TraceScope {
  trace: RunTrace;
  role: TraceRole;
}

const scope = new AsyncLocalStorage<TraceScope>();

/**
 * Run `fn` with capture enabled. A model call made inside this scope but outside
 * any `withRole` is the agent's by definition — the harness's own three stages
 * each name themselves, so anything left over came from the agent under test.
 */
export function withTrace<T>(trace: RunTrace | undefined, fn: () => Promise<T>): Promise<T> {
  return trace ? scope.run({ trace, role: "agent" }, fn) : fn();
}

/** Attribute model calls made inside `fn` to a harness stage. */
export function withRole<T>(role: TraceRole, fn: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ ...current, role }, fn) : fn();
}

export function currentTrace(): RunTrace | undefined {
  return scope.getStore()?.trace;
}

/**
 * One counter across both lists, so the UI can interleave model turns and tool
 * calls in the order they happened. Derived rather than stored — a mutable
 * counter field would be serialized into the artifact for no reason.
 */
function nextSeq(t: RunTrace): number {
  return t.llmCalls.length + t.toolCalls.length;
}

export function recordLlmCall(call: Omit<LlmCall, "seq" | "role">): void {
  const s = scope.getStore();
  if (!s) return;
  s.trace.llmCalls.push({ ...call, seq: nextSeq(s.trace), role: s.role });
}

export function recordToolCall(call: Omit<ToolCall, "seq" | "actionIds">): void {
  const s = scope.getStore();
  if (!s) return;
  s.trace.toolCalls.push({ ...call, seq: nextSeq(s.trace), actionIds: [] });
}

export function recordAgentSummary(summary: string): void {
  const s = scope.getStore();
  if (s) s.trace.agentSummary = summary;
}

/**
 * Link audit rows to the tool calls that produced them, by ordinal position.
 *
 * The agent loop awaits each tool in turn, so mutating calls are strictly
 * sequential and each successful one writes exactly one audit row: the Nth such
 * call produced the Nth row. Matching on that is exact.
 *
 * Timestamps deliberately play no part. A local archive completes well inside a
 * millisecond, so a row's server-side `ts` routinely lands just outside its own
 * call's window — close enough that no containment or nearest-window rule can
 * separate adjacent calls reliably.
 *
 * The invariant assumes nothing else writes to the log mid-run, which holds for
 * an unattended run. If it is ever violated the lists diverge, so pair only up
 * to the shorter one: the prefix stays correct instead of every later call being
 * silently misattributed.
 */
export function attributeActions(trace: RunTrace, actions: ActionRow[]): void {
  const mutations = trace.toolCalls.filter((c) => c.isMutation && !c.error);
  const rows = [...actions].sort((a, b) => a.id - b.id);

  for (let i = 0; i < Math.min(mutations.length, rows.length); i++) {
    mutations[i].actionIds.push(rows[i].id);
  }
}

/** Read calls, oldest first — what the agent looked at, for the judge. */
export function readCalls(trace: RunTrace): ToolCall[] {
  return trace.toolCalls.filter((c) => !c.isMutation);
}
