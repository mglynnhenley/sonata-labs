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

export interface AttioSnapshot {
  twin: "attio";
  capturedAt: number;
  /** Records across every object, flattened: the object is on each row, because
   *  a CRM's shape is "which object is this" more than "which table". */
  records: Array<{
    recordId: string;
    object: string;
    title: string;
    /** The currently-active value per attribute, already rendered to a string —
     *  the versioning is the twin's business, and a snapshot is a moment. */
    values: Record<string, string>;
  }>;
  notes: Array<{ noteId: string; parentObject: string; parentRecordId: string; title: string; excerpt: string }>;
  tasks: Array<{ taskId: string; content: string; isCompleted: boolean; deadlineISO?: string; assignees: string[] }>;
}

export interface GoogleDocsSnapshot {
  twin: "google-docs";
  capturedAt: number;
  documents: Array<{
    documentId: string;
    title: string;
    revisionId: string;
    /** Whose document this is. Every other twin's snapshot names an author —
     *  gmail `from`, slack `user`, calendar `organizer` — and without one here
     *  "the agent rewrote a colleague's brief instead of its own draft" is
     *  invisible to both the diff and the end state. The twin serves it. */
    ownerEmail: string;
    /** Capped by the adapter. A document body is unbounded and most of it is
     *  untouched, so the judge gets the text that changed and a length. */
    excerpt: string;
    characterCount: number;
  }>;
}

export interface GoogleAdsSnapshot {
  twin: "google-ads";
  capturedAt: number;
  campaigns: Array<{
    campaignId: string;
    name: string;
    status: string;
    budgetId: string;
    budgetMicros: number;
    /** Spend over the window the adapter asked for, so "did it overspend" is
     *  answerable from the snapshot alone. */
    costMicros: number;
  }>;
}

export interface LinkedInSnapshot {
  twin: "linkedin";
  capturedAt: number;
  posts: Array<{
    postUrn: string;
    author: string;
    commentary: string;
    lifecycleState: string;
    commentCount: number;
    reactionCount: number;
  }>;
  comments: Array<{ commentUrn: string; postUrn: string; actor: string; text: string; isReply: boolean }>;
}

export type TwinSnapshot =
  | GmailSnapshot
  | SlackSnapshot
  | CalendarSnapshot
  | AttioSnapshot
  | GoogleDocsSnapshot
  | GoogleAdsSnapshot
  | LinkedInSnapshot;

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

export interface AttioDiff {
  twin: "attio";
  created: Array<{ recordId: string; object: string; title: string }>;
  /** A superseded value, before and after — the whole point of this surface. */
  valuesChanged: Array<{ recordId: string; object: string; title: string; attribute: string; from: string; to: string }>;
  /** The parent is named as well as identified: "a note logged against a record"
   *  is the likeliest beat on this surface, and a note on a record that did not
   *  otherwise change has nothing else in the diff to look its title up in — so
   *  without these the judge reads `+ note "Chased the buyer" on "31fedb90-…"`. */
  notesAdded: Array<{
    noteId: string;
    parentObject: string;
    parentRecordId: string;
    parentTitle: string;
    title: string;
    excerpt: string;
  }>;
  /** Assignees, because "raise a follow-up for Priya" is a claim about who it
   *  landed on, and a task nobody is named on is itself the finding. */
  tasksAdded: Array<{ taskId: string; content: string; deadlineISO?: string; assignees: string[] }>;
  tasksCompleted: Array<{ taskId: string; content: string }>;
  unchangedCount: number;
}

export interface GoogleDocsDiff {
  twin: "google-docs";
  created: Array<{ documentId: string; title: string; ownerEmail: string }>;
  /** Edited rather than replaced: a revisionId that moved, with the text that
   *  moved with it, so the judge reads the change and not the whole document.
   *
   *  `approximate` is set when the capture was the HEAD of a document rather
   *  than all of it: the character counts are then the net change the twin
   *  reported and not the exact one, and a same-length rewrite past the cap
   *  counts as nothing. Carried as a field rather than left to inference,
   *  because the one thing a judge must not do is read a net count as an exact
   *  one and conclude the agent wrote less than it did. */
  edited: Array<{
    documentId: string;
    title: string;
    ownerEmail: string;
    charactersAdded: number;
    charactersRemoved: number;
    excerpt: string;
    approximate?: boolean;
  }>;
  renamed: Array<{ documentId: string; from: string; to: string }>;
  unchangedCount: number;
}

export interface GoogleAdsDiff {
  twin: "google-ads";
  statusChanged: Array<{ campaignId: string; name: string; from: string; to: string }>;
  /** Keyed on the campaign and not on the amount: re-pointing a campaign at a
   *  DIFFERENT budget of the same size is a real mutation (campaign.campaignBudget
   *  is writable), and with only the amounts here it was invisible — the campaign
   *  counted as untouched. The two ids are what tell the two moves apart. */
  budgetChanged: Array<{
    campaignId: string;
    name: string;
    fromBudgetId: string;
    toBudgetId: string;
    fromMicros: number;
    toMicros: number;
  }>;
  created: Array<{ campaignId: string; name: string }>;
  unchangedCount: number;
}

/**
 * Every row here carries the post's own words beside its URN, and that is the
 * point of the shape rather than decoration. A URN on this surface is twelve
 * digits nobody typed — an activity id the twin minted — so a judge shown
 * `urn:li:person:elena commented on urn:li:activity:8096605588688817908` cannot
 * tell which post that is, whereas every sibling twin's diff names a thread, a
 * channel, an event or a document. The renderers read `postCommentary` and print
 * the URN only when the post fell outside the capture.
 */
export interface LinkedInDiff {
  twin: "linkedin";
  posted: Array<{ postUrn: string; author: string; commentary: string }>;
  edited: Array<{ postUrn: string; commentary: string }>;
  deleted: Array<{ postUrn: string; commentary: string }>;
  commented: Array<{
    commentUrn: string;
    postUrn: string;
    /** The post this landed under, as it reads. */
    postCommentary: string;
    actor: string;
    text: string;
    isReply: boolean;
  }>;
  reactionsAdded: Array<{
    entityUrn: string;
    /** The post reacted to, as it reads; empty for anything not in the capture. */
    entityCommentary: string;
    actor: string;
    reactionType: string;
  }>;
  unchangedCount: number;
}

export type TwinDiff =
  | GmailDiff
  | SlackDiff
  | CalendarDiff
  | AttioDiff
  | GoogleDocsDiff
  | GoogleAdsDiff
  | LinkedInDiff;

// ---------------------------------------------------------------------------
// Final state. The after-snapshot, narrowed — where each twin ENDED UP, as
// opposed to what moved in it.
//
// A diff and an end state answer different questions and the judge is asked
// both. "Three threads changed" is the diff; "and eleven did not, four of them
// still unread, two from customers who wrote at 09:15" is the end state. A
// criterion like "no customer is left without a response" is a claim about
// where things finished, and what the agent never touched leaves no mark in a
// diff at all — its absence is exactly the thing being asked about. Same on the
// calendar: a diff shows one meeting moved, only the end state shows the
// afternoon it moved into is now double-booked.
//
// Narrowed by RELEVANCE and not by a flat cap: an after-snapshot of the diary
// carries every event the world was seeded with, most of them weeks from the
// day the run simulated, and an event three weeks out cannot bear on today's
// criteria. See `@sonata/judge`'s `project.ts` for the rule each twin uses.
// ---------------------------------------------------------------------------

export interface TwinFinalState {
  /**
   * The after-snapshot with its unbounded list narrowed. Bounded fields — a
   * label list, a channel list — survive whole; they are small and the unread
   * counts on them are half the point of this section.
   */
  state: TwinSnapshot;
  /**
   * Items kept against items the after-snapshot held, where "item" is the one
   * list per twin that grows without bound: gmail threads, slack messages,
   * calendar events.
   */
  coverage: CoverageSlice;
  /**
   * The rule that decided, phrased for the judge to read verbatim — "the inbox,
   * plus every thread the run touched". Per-twin because the rules differ:
   * relevance on a mailbox is a label, on a diary it is a date.
   */
  kept: string;
}

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
  /**
   * Where each twin ended up, narrowed to the day. Kept alongside `diffs`, never
   * instead of it — see `TwinFinalState` for why one cannot answer for the other.
   *
   * A twin the run used whose after-snapshot never landed is absent HERE while
   * still present in `diffs`, and the prompt says so in words: an end state we
   * failed to capture must not render as a surface with nothing left on it.
   */
  finalState: ByTwin<TwinFinalState>;
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
  /**
   * Items listed in WHERE THINGS ENDED UP against items the after-snapshots held.
   * Absent on reports written before the end state reached the judge at all.
   *
   * Recorded like the others and excluded from `fraction` on purpose, because it
   * measures a different thing. The three above drop rows because the DAY did not
   * fit, and a low figure there means the verdict was formed on a sample of what
   * happened. This one drops rows because they are not about this day — a meeting
   * three weeks out, a thread filed months ago — and folding a relevance filter
   * into the headline would report every ordinary run as two-thirds unseen and
   * leave no number free to mean "this day was too big". It is still here because
   * a filtered end state is a filtered end state, and the reader is entitled to
   * know the judge was shown one.
   */
  finalState?: CoverageSlice;
  /**
   * The worst of `steps`, `timeline` and `narration` — the honest headline for the
   * question those three answer, which is how much of the day itself was shown. 1
   * means nothing was dropped. See `finalState` for what this deliberately omits.
   */
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
