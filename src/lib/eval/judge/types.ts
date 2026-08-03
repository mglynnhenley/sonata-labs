import type { AssertionResult } from "../types";

// ---------------------------------------------------------------------------
// Contracts for the failure-mode judge. The judge is a pure pass over saved
// artifacts — everything it sees is defined here, and nothing here touches the
// live mailbox. That's what lets old runs be re-judged with a new model or a
// new prompt without re-running an agent.
// ---------------------------------------------------------------------------

/** Catalog key from `./failureModes`. Kept loose so the catalog owns the list. */
export type FailureModeId = string;

// ---------------------------------------------------------------------------
// Environment. Snapshots are taken around the agent so the run artifact is
// self-contained; the judge is shown only the diff.
// ---------------------------------------------------------------------------

/** Mailbox state at a point in time — the shape both snapshots are captured in. */
export interface MailboxSnapshot {
  capturedAt: number;
  labels: Array<{ id: string; name: string; unread: number }>;
  threads: Array<{
    threadId: string;
    subject: string;
    from: string;
    date: number;
    labels: string[];
    unread: boolean;
    starred: boolean;
    /** Message count, so a reply landing on an existing thread is still visible. */
    count: number;
  }>;
}

/** What the agent changed about the mailbox, derived from two snapshots. */
export interface MailboxDiff {
  /** New threads — in practice the replies the agent sent. */
  added: Array<{ threadId: string; subject: string; from: string }>;
  removed: Array<{ threadId: string; subject: string }>;
  changed: Array<{
    threadId: string;
    subject: string;
    labelsAdded: string[];
    labelsRemoved: string[];
    unreadChanged?: boolean;
    starredChanged?: boolean;
    messagesAdded: number;
  }>;
  /** Count only, never the list — token discipline; a mailbox is mostly untouched. */
  unchangedCount: number;
}

// ---------------------------------------------------------------------------
// Trace, projected. `RunTrace` carries verbatim provider bodies and runs to
// megabytes, so it is never handed to the judge directly — `./project` shrinks
// it to this.
// ---------------------------------------------------------------------------

export interface JudgeTrace {
  steps: Array<{
    /** `RunTrace` seq, preserved so findings can point back at a real step. */
    seq: number;
    name: string;
    args: unknown;
    /** Tool results summarized, not verbatim — a thread list is unbounded. */
    resultSummary: string;
    isMutation: boolean;
    /** Set when the call failed; failed mutations leave no audit row behind. */
    error?: string;
  }>;
  /** The agent's own reasoning, lifted out of the model turns. */
  turns: Array<{ seq: number; text: string }>;
  agentSummary?: string;
}

// ---------------------------------------------------------------------------
// Judge I/O
// ---------------------------------------------------------------------------

/** Everything the judge is given. All three sources come off disk. */
export interface JudgeInput {
  runId: string;
  task: { brief: string; scenarioTitle: string; difficulty: string };
  trace: JudgeTrace;
  env: MailboxDiff;
  /** What the deterministic checks already concluded — the judge need not re-derive it. */
  assertions: AssertionResult[];
}

export interface Finding {
  mode: FailureModeId;
  severity: "critical" | "major" | "minor";
  evidence: string[];
  /** `JudgeTrace.steps` seq values, so the UI can jump to the step. */
  seq?: number[];
}

export interface JudgeReport {
  runId: string;
  judgedAt: number;
  model: string;
  /**
   * The judge restates the task BEFORE assessing anything. If the restatement is
   * wrong, the brief is ambiguous — and that is itself the finding.
   */
  taskUnderstanding: string;
  actionsMakeSense: boolean;
  summary: string;
  /** Only catalog modes the judge actually found — absence is the default. */
  findings: Finding[];
  /** Escape hatch for anything real but uncatalogued; feeds catalog growth. */
  otherFindings: Array<{
    label: string;
    severity: "critical" | "major" | "minor";
    evidence: string[];
  }>;
}
