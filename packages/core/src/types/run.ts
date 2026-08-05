import type { BeatBody, Criterion } from "./episode";
import type { EpisodeJudgeReport, TwinSnapshot } from "./judge";
import type { ByTwin, PersonRef, TwinName } from "./world";

// The artifact a run leaves behind. It is written once and read forever: the
// live dashboard, the step-by-step replay, the judge and the benchmark table all
// read this same object, and a finished run must be re-judgeable with a new
// model months later with nothing live attached. So everything the judge could
// need is in here, including both snapshots per twin.

// ---------------------------------------------------------------------------
// Trace. Structurally identical to apps/gmail's `RunTrace` (src/lib/eval/trace.ts)
// plus optional episode fields, so a Gmail trace is assignable to this without a
// cast and the existing capture hooks keep working unchanged.
// ---------------------------------------------------------------------------

/** Which part of the harness made a model call. */
export type TraceRole = "profiler" | "generator" | "judge" | "agent" | "director" | "world";

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
  /** Tick this call belongs to — absent for calls made outside the tick loop. */
  tick?: number;
  /** Per-call spend, so a cost figure in the dashboard opens its own breakdown. */
  costUsd?: number;
  tokens?: { prompt: number; completion: number };
}

export interface ToolCall {
  seq: number;
  name: string;
  args: unknown;
  result: unknown;
  /** True for tools that change a twin, and so leave audit rows behind. */
  isMutation: boolean;
  startedAt: number;
  endedAt: number;
  /** Set when the call threw or a twin rejected it; such calls log nothing. */
  error?: string;
  /** Audit row ids attributed to this call. */
  actionIds: number[];
  threadId?: string;
  messageId?: string;
  /** Which twin the tool talks to. Absent for harness-local tools. */
  twin?: TwinName;
  tick?: number;
}

export interface AgentTrace {
  runId: string;
  llmCalls: LlmCall[];
  toolCalls: ToolCall[];
  /** The agent's closing account of its own day, which the loop otherwise drops. */
  agentSummary?: string;
}

// ---------------------------------------------------------------------------
// What happened in a tick
// ---------------------------------------------------------------------------

/** What a twin created when a beat or director event was injected into it. */
export interface InjectedRef {
  twin: TwinName;
  /** Gmail message id, Slack `ts`, or calendar event id. */
  id: string;
  /** Gmail thread id, Slack channel id, or calendar id. */
  containerId?: string;
  /** Deep link into the twin's own UI, so every timeline row is a door. */
  url?: string;
}

export interface BeatFired {
  beatId: string;
  /** `BeatMeta.ref`, carried through so criteria can resolve it to `handle`. */
  ref?: string;
  twin: TwinName;
  kind: string;
  /** Absent when injection failed — `error` says why. */
  handle?: InjectedRef;
  /** One line for the timeline: "Dana Reyes emailed about the missed SLA". */
  summary: string;
  error?: string;
}

/**
 * Something the world did *because of* the agent, improvised at runtime. The
 * body is the same (twin, kind, payload) triple a scripted beat carries, so both
 * go through one injector — the only difference is who wrote it.
 */
export type DirectorEvent = BeatBody & {
  id: string;
  /** The persona who acted, by `Person.id`. */
  personId: PersonRef;
  /** Why the director fired this, in one line. Shown in the timeline. */
  reason: string;
  /** `AgentStep.seq` this answers, so the replay can draw the causal link. */
  becauseSeq?: number;
  handle?: InjectedRef;
  error?: string;
};

/**
 * One thing the agent did. `escalation` is its own kind rather than a tool call
 * because autonomy is the headline score: handing the job back to a human has to
 * be countable, not inferred from prose.
 */
export type AgentStep =
  | { kind: "thought"; seq: number; at: number; text: string }
  | {
      kind: "tool";
      seq: number;
      at: number;
      twin: TwinName | null;
      name: string;
      args: unknown;
      /** Result summarized, not verbatim — a thread list is unbounded. */
      resultSummary: string;
      isMutation: boolean;
      error?: string;
    }
  | { kind: "escalation"; seq: number; at: number; text: string };

export interface TickRecord {
  tick: number;
  /** Simulated time at the start of the tick, from `tickToISO`. */
  simTimeISO: string;
  startedAt: number;
  endedAt: number;
  beatsFired: BeatFired[];
  directorEvents: DirectorEvent[];
  agentSteps: AgentStep[];
  /** Engine notes: why the director stayed quiet, a twin that returned 500. */
  notes: string[];
}

/** One row of the run's story, flattened across sources for the judge and the UI. */
export interface TimelineEntry {
  tick: number;
  simTimeISO: string;
  /** `world` = scripted beat, `director` = a person reacting, `agent` = the agent. */
  source: "world" | "director" | "agent";
  twin: TwinName | null;
  text: string;
  /** `AgentStep.seq`, when this row is an agent step. */
  seq?: number;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * What a checker concluded about one criterion. Three states, not two.
 *
 * `notApplicable` is the whole point of the type: a criterion can hold for a
 * reason that is no credit to the agent ("never handed the job back" — it never
 * did anything at all), or be undecidable ("the surface was never captured").
 * Both used to arrive as a boolean, and a boolean forces a lie either way: `true`
 * pays an idle agent for work it did not do, `false` reports a failure that never
 * happened. Neither may reach a published table, so scoring drops these from the
 * numerator AND the denominator — see `checklistScore`.
 */
export type CriterionStatus = "passed" | "failed" | "notApplicable";

export interface CriterionResult {
  id: string;
  description: string;
  twin: Criterion["twin"];
  kind: Criterion["kind"];
  severity: Criterion["severity"];
  weight: number;
  status: CriterionStatus;
  /** What made the checker decide — quoted, so a failed criterion shows its work. */
  evidence?: string;
  /** Tick the criterion was satisfied on, when it was. */
  tick?: number;
}

export interface RunCost {
  usd: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
}

export interface EpisodeVerdict {
  outcome: "pass" | "partial" | "fail";
  /** Weighted fraction of the checklist that passed, 0..1. */
  score: number;
  /** How much of the job got done without a human stepping in, 0..1. */
  autonomy: number;
  checklist: CriterionResult[];
  /** Null until the judge has run; a run is scoreable before it is judged. */
  judge: EpisodeJudgeReport | null;
  cost: RunCost;
}

export type RunStatus = "queued" | "running" | "judging" | "done" | "failed" | "aborted";

export interface EpisodeRun {
  runId: string;
  specId: string;
  /** Denormalized so a runs list renders without loading every spec. */
  specTitle: string;
  /** The model under test, as an OpenRouter id. */
  model: string;
  status: RunStatus;
  startedAt: number;
  /** Null while the run is still going. */
  endedAt: number | null;
  ticks: TickRecord[];
  /** State either side of the agent, per twin — only for twins the run used. */
  snapshots: ByTwin<{ before: TwinSnapshot; after: TwinSnapshot }>;
  /** Null until scoring; set even for a failed run if the checklist could be read. */
  verdict: EpisodeVerdict | null;
  /** Why the run ended badly, when it did. */
  error?: string;
}
