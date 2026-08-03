import type { gmail_v1 } from "googleapis";
import type { MailboxProfile, StressScenario } from "../types";

// ---------------------------------------------------------------------------
// The generator pipeline's stage contract. Building a hard scenario is a research
// task — find relevant history, judge which of it is usable, read it, get the
// dates right, weigh angles, write — and doing all six in one LLM call is why the
// old generator anchored to threads that disproved the scenario's own premise.
//
// Each stage is a pure-ish `In -> Out` step that may touch only its input and
// `ctx`. That is what makes any stage swappable, stubbable, and unit-testable in
// isolation, and it lets the driver retain every intermediate output on the trace.
// ---------------------------------------------------------------------------

export interface StageCtx {
  gmail: gmail_v1.Gmail;
  userId: string;
  scenario: StressScenario;
  profile: MailboxProfile;
  /**
   * Injected wall clock. A stage must NEVER call `Date.now()` — date logic is the
   * step that was broken (probes claiming "as I mentioned yesterday" on an April
   * thread), so it has to be drivable from a fixed clock in tests.
   */
  now: number;
  /** Per-stage model override — cheap for ranking, expensive for composing. */
  model(stage: string): string | undefined;
  /** Progress line, wired to the CLI's `--explain` / `onProgress`. */
  say(msg: string): void;
}

export interface Stage<In, Out> {
  name: string;
  run(input: In, ctx: StageCtx): Promise<Out>;
}

/** A thread the scenario could be staged on, flattened from its last message. */
export interface Candidate {
  threadId: string;
  lastMessageId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  internalDate: number;
  /** Thread depth — a one-shot blast reads very differently from a long exchange. */
  messageCount: number;
  /** Did the owner ever answer? `escalation` needs no, `already-resolved` needs yes. */
  ownerReplied: boolean;
  bodyExcerpt: string;
}

/** A scored candidate. `reasons` is kept so `--explain` can show why one won. */
export interface Ranked {
  candidate: Candidate;
  score: number;
  reasons: string[];
}

/** What the winning thread is actually about, read in full rather than excerpted. */
export interface ThreadContext {
  threadId: string;
  summary: string;
  /** Where the conversation stopped, in the participants' own terms. */
  leftOffAt: string;
  /** Who owes whom what — the debt a probe can plausibly call in. */
  owes: string;
  openQuestions: string[];
  tone: string;
}

/** One slot's resolved absolute time. */
export interface SlotTime {
  slotId: string;
  at: number;
  /** Human phrasing the composer can quote verbatim, e.g. "Tue 14 Apr, 3 months ago". */
  phrase: string;
}

/**
 * Every slot's time, derived from the anchor's real `internalDate` rather than from
 * `now`. Slot offsets that would land before the anchor get rebased, so the probe
 * can never reference history it predates.
 */
export interface Timeline {
  anchorLastAt: number;
  anchorPhrase: string;
  slots: SlotTime[];
}

/** One candidate angle on the scenario, before the best is selected. */
export interface Approach {
  id: string;
  angle: string;
  rationale: string;
  /** 0..1 — how believable this angle is given the real thread. */
  plausibility: number;
}
