import type { gmail_v1 } from "googleapis";
import type { ActionRow } from "../audit";

// ---------------------------------------------------------------------------
// Triage stress-test eval. A scenario is an abstract, data-agnostic template;
// its roles bind to whatever contacts exist in the loaded mailbox at runtime.
// ---------------------------------------------------------------------------

/** A real contact discovered in the mailbox, used to make probes plausible. */
export interface Contact {
  name: string;
  email: string;
  relationship: string; // "manager", "close colleague", "vendor", "family"
  styleNotes: string; // how this person writes
}

export interface MailboxProfile {
  personaSummary: string;
  ownerEmail: string;
  ownerName: string;
  contacts: Contact[];
  topics: string[];
}

/** A real thread a probe can reply into, so the agent must work with real history. */
export interface Anchor {
  threadId: string;
  lastMessageId: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  bodyExcerpt: string;
}

/** A real message used as a few-shot style exemplar. */
export interface Exemplar {
  fromAddr: string;
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Fixtures. A scenario declares SLOTS (structure — code-controlled), and the
// generator fills in only subject/body prose. Keeping labels, backdating, and
// threading out of the model's hands makes fixtures deterministic and testable.
// ---------------------------------------------------------------------------

export interface MessageSlot {
  /** Stable slot key, e.g. "prior" | "probe" | "resolution". */
  id: string;
  /** Who sends it. `contact` = the bound contact; `owner` = the mailbox owner. */
  sender: "contact" | "owner";
  /** Backdating: how long before "now" this message arrived. */
  minutesAgo: number;
  labels: string[];
  /** Thread this slot onto an earlier slot id, or onto the real anchor thread. */
  threadWith?: string | "anchor";
  /** Instruction to the generator describing what this email should say. */
  brief: string;
}

/** A concrete message ready to inject. */
export interface FixtureMessage {
  slotId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  minutesAgo: number;
  labels: string[];
  replyToSlotId?: string;
  replyToRealMessageId?: string;
}

export interface Fixture {
  messages: FixtureMessage[];
  /** Slot id of the message under test. */
  probeSlotId: string;
  /** Slot id of the "prior" message, when the scenario has one. */
  priorSlotId?: string;
}

export interface InjectedMessage {
  slotId: string;
  id: string;
  threadId: string;
  rfc822MessageId: string;
}

// ---------------------------------------------------------------------------
// Observation + grading
// ---------------------------------------------------------------------------

/** What the agent actually did to a probe, derived from audit log + final state. */
export interface ProbeOutcome {
  messageId: string;
  threadId: string;
  exists: boolean; // false if permanently deleted
  finalLabels: string[];
  archived: boolean; // INBOX removed
  trashed: boolean;
  starred: boolean;
  markedRead: boolean;
  labelsAdded: string[]; // non-system labels present at the end
  replied: boolean;
  replyText: string;
  /** Did the agent act on the prior fixture message at all (incl. bulk-processing it)? */
  touchedPrior: boolean;
  /**
   * Did it *surface* the prior message (starred / marked important / labelled)
   * rather than bury it? Bulk-archiving the inbox sets `touchedPrior` but not
   * this — so this is the signal the history assertions use.
   */
  surfacedPrior: boolean;
  /** Audit rows touching this message or its thread. */
  actions: ActionRow[];
  /** Every audit row from the run (for the judge + report). */
  allActions: ActionRow[];
}

export interface GradeCtx {
  scenario: StressScenario;
  fixture: Fixture;
  injected: InjectedMessage[];
  probe: InjectedMessage;
  prior?: InjectedMessage;
  anchor: Anchor | null;
}

export interface Assertion {
  id: string;
  description: string;
  /** `must` violations fail the run outright; `should` violations cost score. */
  severity: "must" | "should";
  check(o: ProbeOutcome, ctx: GradeCtx): boolean;
}

export interface AssertionResult {
  id: string;
  description: string;
  severity: "must" | "should";
  passed: boolean;
}

export interface JudgeVerdict {
  handledWell: boolean;
  reasoning: string;
  evidence: string[];
}

export interface Verdict {
  outcome: "pass" | "partial" | "fail";
  score: number; // 0..1 over `should` assertions
  assertions: AssertionResult[];
  judge: JudgeVerdict | null;
}

export type ScenarioFamily = "requires-history" | "interpersonal";

export interface StressScenario {
  id: string;
  title: string;
  family: ScenarioFamily;
  /** What makes this situation hard — shown in the report. */
  difficulty: string;
  /** Prefer threading the probe onto a real thread when one is available. */
  preferAnchor: boolean;
  slots: MessageSlot[];
  assertions: Assertion[];
  /** Qualitative question for the LLM judge (the residue assertions can't cover). */
  judgeQuestion: string;
}

// ---------------------------------------------------------------------------
// Agent under test
// ---------------------------------------------------------------------------

export interface TriageContext {
  gmail: gmail_v1.Gmail;
  userId: string;
  brief: string;
}

export interface TriageAgent {
  name: string;
  triage(ctx: TriageContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface EvalReport {
  scenarioId: string;
  scenarioTitle: string;
  family: ScenarioFamily;
  agentName: string;
  anchoredToRealThread: boolean;
  fixture: Fixture;
  injected: InjectedMessage[];
  outcome: ProbeOutcome;
  verdict: Verdict;
  durationMs: number;
}
