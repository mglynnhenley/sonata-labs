import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentStep,
  AgentTrace,
  LlmCall,
  ToolCall,
  TraceRole,
  TwinAuditRow,
  TwinName,
} from "@sonata/core";

// Capture of everything the harness asked a model to do, and everything the agent
// under test did to the three twins.
//
// This is apps/gmail's src/lib/eval/trace.ts, mirrored rather than imported: that
// file lives inside a Next app whose package exports nothing and whose imports go
// through `@/` aliases, so it is not reachable from a workspace package. The types
// it defines have already moved to @sonata/core (`AgentTrace` is documented there
// as structurally identical to Gmail's `RunTrace`), so only the AsyncLocalStorage
// machinery is duplicated — widened here with two things a single-mailbox eval
// had no use for: a `tick`, so a call can be placed on the simulated day, and a
// `twin`, so a tool call knows which surface it touched.
//
// Capture stays *ambient*: it hangs off AsyncLocalStorage rather than a parameter,
// so no signature in the engine changes to opt in, and a custom agent gets traced
// without knowing traces exist. Outside a `withTrace` scope every hook is a no-op,
// which is what keeps the zero-model-call paths (unit tests, replay) untouched.

export function newTrace(runId: string): AgentTrace {
  return { runId, llmCalls: [], toolCalls: [] };
}

interface TraceScope {
  trace: AgentTrace;
  role: TraceRole;
  tick?: number;
}

const scope = new AsyncLocalStorage<TraceScope>();

/**
 * Run `fn` with capture enabled. A model call made inside this scope but outside
 * any `withRole` is the agent's by definition — the harness's own stages each
 * name themselves, so anything left over came from the agent under test.
 */
export function withTrace<T>(trace: AgentTrace | undefined, fn: () => Promise<T>): Promise<T> {
  return trace ? scope.run({ trace, role: "agent" }, fn) : fn();
}

/** Attribute model calls made inside `fn` to a harness stage. */
export function withRole<T>(role: TraceRole, fn: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ ...current, role }, fn) : fn();
}

/**
 * Stamp everything recorded inside `fn` with the simulated tick it happened on.
 * The replay scrubs by tick, so a call with no tick is a call the timeline cannot
 * place — every call the loop makes goes inside one of these.
 */
export function withTick<T>(tick: number, fn: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ ...current, tick }, fn) : fn();
}

export function currentTrace(): AgentTrace | undefined {
  return scope.getStore()?.trace;
}

export function currentTick(): number | undefined {
  return scope.getStore()?.tick;
}

/**
 * One counter across both lists, so the UI can interleave model turns and tool
 * calls in the order they happened. Derived rather than stored — a mutable
 * counter field would be serialized into the artifact for no reason.
 */
function nextSeq(t: AgentTrace): number {
  return t.llmCalls.length + t.toolCalls.length;
}

export function recordLlmCall(call: Omit<LlmCall, "seq" | "role" | "tick">): void {
  const s = scope.getStore();
  if (!s) return;
  s.trace.llmCalls.push({
    ...call,
    seq: nextSeq(s.trace),
    role: s.role,
    ...(s.tick === undefined ? {} : { tick: s.tick }),
  });
}

export function recordToolCall(call: Omit<ToolCall, "seq" | "actionIds" | "tick">): void {
  const s = scope.getStore();
  if (!s) return;
  s.trace.toolCalls.push({
    ...call,
    seq: nextSeq(s.trace),
    actionIds: [],
    ...(s.tick === undefined ? {} : { tick: s.tick }),
  });
}

export function recordAgentSummary(summary: string): void {
  const s = scope.getStore();
  if (s) s.trace.agentSummary = summary;
}

/**
 * Link audit rows to the tool calls that produced them, per twin, by ordinal
 * position.
 *
 * The agent loop awaits each tool in turn, so mutating calls are strictly
 * sequential and each successful one writes exactly one audit row *in its own
 * twin's log*: within a twin, the Nth such call produced the Nth row. Matching on
 * that is exact. Across twins it would not be — three independent id sequences
 * interleave arbitrarily — which is why the pairing is done per twin.
 *
 * Timestamps deliberately play no part. A local mutation completes well inside a
 * millisecond, so a row's server-side `ts` routinely lands just outside its own
 * call's window — close enough that no containment rule can separate adjacent
 * calls reliably.
 *
 * The invariant assumes nothing else writes to a twin's log mid-run. Scripted
 * beats and director events are injected through non-audited sandbox routes
 * precisely so that holds. If it is ever violated the lists diverge, so pair only
 * up to the shorter one: the prefix stays correct instead of every later call
 * being silently misattributed.
 */
export function attributeActions(trace: AgentTrace, twin: TwinName, rows: TwinAuditRow[]): void {
  const mutations = trace.toolCalls.filter((c) => c.twin === twin && c.isMutation && !c.error);
  const ordered = [...rows].sort((a, b) => a.id - b.id);

  for (let i = 0; i < Math.min(mutations.length, ordered.length); i++) {
    mutations[i].actionIds.push(ordered[i].id);
  }
}

/**
 * The identity of an audit row across the three twins.
 *
 * `TwinAuditRow.id` is NOT it. Each twin keeps its own `action_log` in its own
 * `audit.db` with its own `INTEGER PRIMARY KEY AUTOINCREMENT`, so all three id
 * sequences start at 1 and overlap for the whole run: on the tick an agent both
 * emails the client and posts in #ops, gmail row 1 and slack row 1 are in the
 * same delta list. Anything keyed on the number alone silently collapses them —
 * which put a Slack one-liner under the email that carried the credit amount, and
 * the client then escalated about a figure it had already been given.
 */
export function auditKey(row: Pick<TwinAuditRow, "twin" | "id">): string {
  return `${row.twin}:${row.id}`;
}

/**
 * Which agent step wrote which audit row, keyed by `auditKey`.
 *
 * The same pairing `attributeActions` does, over the agent's STEPS rather than
 * the trace's tool calls, and over one tick's worth rather than the whole run.
 * The invariant is the one documented above: the agent awaits each tool in turn,
 * so within a single twin's log the Nth successful mutation is the Nth row.
 * Across twins it does not hold, so this groups by `AgentStep.twin` first — and
 * the key it returns stays twin-qualified for the same reason.
 *
 * Two callers want the answer for opposite reasons — the director wants the prose
 * the step carried, the artifact wants `DirectorEvent.becauseSeq` — and both are
 * wrong in the same way if the pairing slips, so there is one of it.
 *
 * Aligned from the END of each list rather than the start. In an ordinary tick
 * the lists are the same length and it makes no difference. When a twin could not
 * be read for a tick — `readDeltas` swallows that deliberately — its rows turn up
 * on the NEXT read alongside that tick's own, and it is the TAIL of that longer
 * row list that belongs to the steps being held. Aligning from the start would
 * hand the world the previous tick's words as if they were this tick's.
 */
export function pairRowsToSteps(
  steps: readonly AgentStep[],
  rows: readonly TwinAuditRow[],
): Map<string, AgentStep> {
  const out = new Map<string, AgentStep>();
  for (const twin of new Set(rows.map((r) => r.twin))) {
    const mine = rows.filter((r) => r.twin === twin).sort((a, b) => a.id - b.id);
    // Same predicate as `attributeActions`: a read writes no row, and a call the
    // twin rejected wrote nothing to pair with.
    const wrote = steps.filter((s) => s.kind === "tool" && s.isMutation && !s.error && s.twin === twin);
    const n = Math.min(mine.length, wrote.length);
    for (let i = 0; i < n; i++) {
      out.set(auditKey(mine[mine.length - n + i]), wrote[wrote.length - n + i]);
    }
  }
  return out;
}

/** Read calls, oldest first — what the agent looked at, for the judge. */
export function readCalls(trace: AgentTrace): ToolCall[] {
  return trace.toolCalls.filter((c) => !c.isMutation);
}

export interface TraceCost {
  usd: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
}

/**
 * What the run has spent so far. Summed from the calls themselves rather than
 * tracked in a counter, so the number on the results page is re-derivable from
 * the saved artifact — and so a mid-run budget check and the final figure can
 * never disagree.
 */
export function traceCost(trace: AgentTrace): TraceCost {
  let usd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const call of trace.llmCalls) {
    usd += call.costUsd ?? 0;
    promptTokens += call.tokens?.prompt ?? 0;
    completionTokens += call.tokens?.completion ?? 0;
  }
  return { usd, promptTokens, completionTokens, llmCalls: trace.llmCalls.length };
}
