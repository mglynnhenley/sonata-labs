import type { CriterionResult, TimelineEntry } from "./run";
import type { ByTwin, TwinName } from "./world";

// Contracts for the episode judge — the Gmail failure-mode judge (apps/gmail
// src/lib/eval/judge/types.ts) widened from one mailbox to three surfaces and
// from one moment to a whole day.
//
// The judge stays a pure pass over saved artifacts: everything it sees is
// defined here and nothing here touches a live twin. That is what lets an old
// run be re-judged with a new model or a new prompt without re-running an agent.

/** Catalog key from `../failureModes`. Loose, so the catalog owns the list. */
export type FailureModeId = string;

export type Severity = "critical" | "major" | "minor";

// ---------------------------------------------------------------------------
// Snapshots. Taken either side of the agent, through the same public API the
// agent uses — a snapshot can only see what the agent could have changed.
// ---------------------------------------------------------------------------

export interface GmailSnapshot {
  twin: "gmail";
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
  /** Drafts are the tell for "wrote it but would not send it" — an autonomy signal. */
  drafts: Array<{
    draftId: string;
    threadId?: string;
    to: string[];
    subject: string;
    excerpt: string;
  }>;
}

export interface SlackSnapshot {
  twin: "slack";
  capturedAt: number;
  channels: Array<{
    id: string;
    name: string;
    isPrivate: boolean;
    memberCount: number;
    messageCount: number;
  }>;
  /** Capped and recent-first by the adapter; a workspace history is unbounded. */
  messages: Array<{
    channelId: string;
    channelName: string;
    ts: string;
    user: string;
    text: string;
    threadTs?: string;
    replyCount: number;
    reactions: string[];
  }>;
}

export interface CalendarSnapshot {
  twin: "calendar";
  capturedAt: number;
  events: Array<{
    eventId: string;
    title: string;
    startISO: string;
    endISO: string;
    organizer: string;
    attendees: Array<{ email: string; response: string }>;
    location?: string;
    status: "confirmed" | "tentative" | "cancelled";
  }>;
}

export type TwinSnapshot = GmailSnapshot | SlackSnapshot | CalendarSnapshot;

// ---------------------------------------------------------------------------
// Diffs. Derived from two snapshots by the twin's adapter, and pure — old
// artifacts can be re-diffed offline. Each carries `unchangedCount` as a count
// and never a list: token discipline, since most of a world is untouched.
// ---------------------------------------------------------------------------

export interface GmailDiff {
  twin: "gmail";
  /** New threads — in practice, what the agent sent. */
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
  draftsAdded: Array<{ draftId: string; subject: string; to: string[]; excerpt: string }>;
  unchangedCount: number;
}

export interface SlackDiff {
  twin: "slack";
  posted: Array<{
    channelName: string;
    ts: string;
    user: string;
    text: string;
    threadTs?: string;
  }>;
  edited: Array<{ channelName: string; ts: string; text: string }>;
  deleted: Array<{ channelName: string; ts: string }>;
  reactionsAdded: Array<{ channelName: string; ts: string; emoji: string; user: string }>;
  channelsCreated: string[];
  unchangedCount: number;
}

export interface CalendarDiff {
  twin: "calendar";
  created: Array<{ eventId: string; title: string; startISO: string; attendees: string[] }>;
  cancelled: Array<{ eventId: string; title: string }>;
  moved: Array<{ eventId: string; title: string; fromISO: string; toISO: string }>;
  attendeesChanged: Array<{ eventId: string; title: string; added: string[]; removed: string[] }>;
  rsvpChanged: Array<{ eventId: string; who: string; from: string; to: string }>;
  unchangedCount: number;
}

export type TwinDiff = GmailDiff | SlackDiff | CalendarDiff;

// ---------------------------------------------------------------------------
// Trace, projected. `AgentTrace` carries verbatim provider bodies and runs to
// megabytes, so it never reaches the judge directly — each adapter's
// `projectTrace` shrinks its own calls to these steps.
// ---------------------------------------------------------------------------

export interface JudgeStep {
  /** `AgentTrace` seq, preserved so a finding can point at a real step. */
  seq: number;
  tick?: number;
  twin: TwinName | null;
  name: string;
  args: unknown;
  /** Tool results summarized, not verbatim — a thread list is unbounded. */
  resultSummary: string;
  isMutation: boolean;
  /** Set when the call failed; failed mutations leave no audit row behind. */
  error?: string;
}

export interface JudgeTrace {
  steps: JudgeStep[];
  /** The agent's own reasoning, lifted out of the model turns. */
  turns: Array<{ seq: number; tick?: number; text: string }>;
  /** Every moment it handed the job back to a human — the autonomy evidence. */
  escalations: Array<{ seq: number; tick?: number; text: string }>;
  agentSummary?: string;
}

// ---------------------------------------------------------------------------
// Judge I/O
// ---------------------------------------------------------------------------

/** Everything the judge is given. All of it comes off disk. */
export interface EpisodeJudgeInput {
  runId: string;
  specId: string;
  /** The agent's standing brief, verbatim — the judge restates it before assessing. */
  task: string;
  /** The day as the author wrote it, so the judge knows what was meant to happen. */
  story: string;
  /** What actually happened, in order, across all three surfaces. */
  timeline: TimelineEntry[];
  /** What changed in each twin the run used. */
  diffs: ByTwin<TwinDiff>;
  trace: JudgeTrace;
  /** What the deterministic checks concluded — the judge need not re-derive it. */
  checklistResults: CriterionResult[];
  /** `SuccessCriteria.judgeQuestions`, asked verbatim. */
  judgeQuestions: string[];
}

export interface Finding {
  mode: FailureModeId;
  severity: Severity;
  evidence: string[];
  /** Which tick it happened on, so the timeline can scroll to the moment. */
  tick?: number;
  /** `JudgeStep.seq` values, so the replay can jump to the step. */
  seq?: number[];
}

/** Escape hatch for anything real but uncatalogued; feeds catalog growth. */
export interface OtherFinding {
  label: string;
  severity: Severity;
  evidence: string[];
  tick?: number;
}

/** One unbounded list the judge was shown, and how much of it reached the prompt. */
export interface CoverageSlice {
  shown: number;
  total: number;
}

/**
 * How much of the run the judge actually read.
 *
 * A day can outgrow any context window, so the prompt samples the long lists — and
 * a verdict formed on a sample is not the same claim as a verdict formed on the
 * whole day. This is the report's own record of which one it is, kept next to the
 * findings rather than buried in the prompt that produced them, because the reader
 * of the report is the person whose confidence is at stake.
 */
export interface JudgeCoverage {
  /** Tool calls listed in WHAT THE AGENT DID. */
  steps: CoverageSlice;
  /** Timeline rows across THE DAY, AS IT HAPPENED and WHAT THE WORLD DID BACK. */
  timeline: CoverageSlice;
  /** The agent's own turns. Escalations are never dropped and never counted here. */
  narration: CoverageSlice;
  /** The worst of the three ratios — the honest headline. 1 means nothing was dropped. */
  fraction: number;
  /** `fraction === 1`. Stored so a reader never has to trust a float comparison. */
  complete: boolean;
}

export interface EpisodeJudgeReport {
  runId: string;
  judgedAt: number;
  model: string;
  /**
   * Absent on reports written before coverage was tracked, and absent is NOT the
   * same as complete: an old report is a verdict of unknown provenance, so a UI
   * must say "not recorded" rather than assume the judge saw the whole day.
   */
  coverage?: JudgeCoverage;
  /**
   * The judge restates the task BEFORE assessing anything. If the restatement is
   * wrong, the brief is ambiguous — and that is itself the finding.
   */
  taskUnderstanding: string;
  /**
   * 0..1 — how much of the job got done without a human stepping in. The headline
   * number. `autonomyScore` in ../score derives the same figure deterministically
   * from the checklist and findings; keeping both lets the two be compared, and a
   * wide gap is a sign the catalog is missing a mode.
   */
  autonomyScore: number;
  summary: string;
  /** Only catalog modes the judge actually found — absence is the default. */
  findings: Finding[];
  otherFindings: OtherFinding[];
  /** One answer per `EpisodeJudgeInput.judgeQuestions`, in the same order. */
  answers: Array<{ question: string; answer: string }>;
}
