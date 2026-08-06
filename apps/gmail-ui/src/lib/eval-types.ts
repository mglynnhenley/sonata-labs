// The eval/trace shapes the operator Trace panel renders. These describe the
// JSON the panel receives from the API via the /api/eval/* proxy. Duplicated
// here (per the twins' no-shared-package convention) so the UI service does not
// import the API's internal eval modules — it is a decoupled service that only
// knows the wire shapes, exactly like any third-party client would.

export type TraceRole = "profiler" | "generator" | "judge" | "agent";

export interface LlmCall {
  seq: number;
  role: TraceRole;
  model: string;
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
  isMutation: boolean;
  startedAt: number;
  endedAt: number;
  error?: string;
  actionIds: number[];
  threadId?: string;
  messageId?: string;
}

export interface RunTrace {
  runId: string;
  llmCalls: LlmCall[];
  toolCalls: ToolCall[];
  agentSummary?: string;
}

export interface RunSummary {
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  agentName: string;
  outcome: string;
  score: number;
  durationMs: number;
  hasTrace: boolean;
  hasJudge: boolean;
}

export type FailureModeId = string;

export interface Finding {
  mode: FailureModeId;
  severity: "critical" | "major" | "minor";
  evidence: string[];
  seq?: number[];
}

export interface JudgeReport {
  runId: string;
  judgedAt: number;
  model: string;
  taskUnderstanding: string;
  actionsMakeSense: boolean;
  summary: string;
  findings: Finding[];
  otherFindings: Array<{
    label: string;
    severity: "critical" | "major" | "minor";
    evidence: string[];
  }>;
}

/** id → label for the findings list. The panel only needs these two fields. */
export const FAILURE_MODES: Array<{ id: string; label: string }> = [
  { id: "acted-without-reading", label: "Acted without reading" },
  { id: "bulk-swept", label: "Bulk swept" },
  { id: "missed-history", label: "Missed thread history" },
  { id: "replied-on-guess", label: "Replied on a guess" },
  { id: "wrong-recipients", label: "Wrong recipients" },
  { id: "destructive-overreach", label: "Destructive overreach" },
  { id: "ignored-probe", label: "Ignored the message" },
  { id: "date-blind", label: "Date-blind" },
  { id: "tone-mismatch", label: "Tone mismatch" },
  { id: "overconfident", label: "Overconfident" },
  { id: "task-drift", label: "Task drift" },
];
