import type { RunStatus, TickRecord, TwinName, VerdictOutcome } from "@sonata/core";

// The wire shapes between the sessions pages and the routes that serve them.
//
// Type-only apart from one catalog, exactly like app/api/_lib/types.ts: the live
// session view is a client component, and anything it imports is compiled into
// the browser bundle — so nothing here may reach a database or the engine.

// ---------------------------------------------------------------------------
// A SESSION, as opposed to a run.
//
// A run calls the agent. A session does not: the world plays on a wall-clock
// timer at a declared compression, and the agent — OpenClaw, Claude Code,
// whatever the operator plugged in — notices by polling the twins and acts when
// it decides to. Everything on this page is therefore read out of the world
// rather than out of the agent, which is what makes it work with any agent at
// all and also what it cannot show. See `SessionView.caveats`.
// ---------------------------------------------------------------------------

/** What the agent looks like right now, at a glance. */
export type AgentPulse =
  /** The world is still being stood up; the agent has had nothing to notice. */
  | "starting"
  /** It did something in the interval that just closed. */
  | "acting"
  /** It has done nothing for at least one interval. */
  | "idle"
  /** The day is over. */
  | "ended";

export interface SessionView {
  sessionId: string;
  episodeId: string;
  title: string;
  /** What the operator called the connected agent, e.g. "openclaw@laptop". */
  agentLabel: string;
  /** `EpisodeRun.model` on the artifact — how Results tells a session from a run. */
  model: string;
  status: RunStatus;
  twins: TwinName[];
  /** Ticks recorded so far. */
  tick: number;
  plannedTicks: number;
  /** Simulated time at the head of the day. */
  simTimeISO: string;
  simMinutesPerTick: number;
  /** Simulated seconds per real second. */
  compression: number;
  /** Real milliseconds one tick occupies at that compression. */
  realMsPerTick: number;
  lastEvent: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Wall clock the next tick is due. Null when nothing is scheduled. */
  nextTickAt: number | null;
  /** Scripted arrivals so far. */
  beats: number;
  /** Replies the director wrote back. */
  directorEvents: number;
  /** Things the agent changed in a twin, from the audit logs. */
  agentActions: number;
  /**
   * Wall clock of the last thing the agent did — a change, or a hand-back the
   * harness reported. Wider than `agentActions` on purpose: a session that only
   * heard an escalation heard something, and that is not silence.
   */
  lastAgentActionAt: number | null;
  /** Consecutive intervals with nothing from the agent, right now. */
  idleStreak: number;
  longestIdleStreak: number;
  outcome: VerdictOutcome | null;
  score: number | null;
  autonomy: number | null;
  /** What the world cost to run. Never what the agent cost — it is not ours. */
  costUsd: number;
  /** Why the day ended, in the words to print. */
  endedBecause: string | null;
  /** Set when the day was never scored, and why. */
  noResult: string | null;
  error: string | null;
  /** What this record cannot carry, from the engine. Filled once the day ends. */
  caveats: string[];
  /** True while this process is still running the world. */
  live: boolean;
}

export interface SessionPoll {
  session: SessionView;
  /** Only the ticks the caller has not seen. */
  ticks: TickRecord[];
  /** Pass back as the next `sinceTick`. */
  nextSinceTick: number;
  /** Server clock, so a countdown to the next tick survives hydration. */
  at: number;
}

export interface SessionsFeed {
  sessions: SessionView[];
  at: number;
}

export interface StartSessionInput {
  episodeId: string;
  /** Simulated seconds per real second. See `COMPRESSIONS`. */
  compression: number;
  agentLabel?: string;
  twins?: TwinName[];
  ticks?: number;
  /** Reload the cloned business into the twins first. On by default. */
  seedWorld?: boolean;
  /** Read the finished day back with the judge. On by default. */
  judge?: boolean;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

export interface CompressionOption {
  /** Simulated seconds per real second. */
  factor: number;
  label: string;
  hint: string;
}

/**
 * The rates worth offering.
 *
 * This is the one choice a session has that a run does not, and it is a real
 * trade: the faster the day, the less time the agent has between beats to
 * notice anything. Anything above an hour a minute is measuring the harness
 * rather than the agent, and the hints say so rather than leaving an operator
 * to discover it from a session where the agent never got a turn.
 */
export const COMPRESSIONS: readonly CompressionOption[] = [
  {
    factor: 3600,
    label: "Flat out",
    hint: "A whole day in seconds. Checks the wiring; no agent can keep up.",
  },
  {
    factor: 360,
    label: "Six hours a minute",
    hint: "A quick pass. Only an agent polling every second or two will see it all.",
  },
  {
    factor: 60,
    label: "An hour a minute",
    hint: "The default. A workday in about eight minutes.",
  },
  {
    factor: 12,
    label: "An hour every five minutes",
    hint: "Comfortable for an agent that checks in every minute or so.",
  },
  {
    factor: 1,
    label: "Real time",
    hint: "The day takes the day. For an agent you leave running.",
  },
];

export const DEFAULT_COMPRESSION_FACTOR = 60;

/** One scenario, priced in real time at each rate, for the start panel. */
export interface SessionScenario {
  id: string;
  title: string;
  story: string;
  twins: TwinName[];
  ticks: number;
  simMinutesPerTick: number;
  /**
   * How long the day takes at each rate, computed server-side with the engine's
   * own formula — so the number an operator commits an afternoon to cannot drift
   * from the one the scheduler uses.
   */
  realMs: Array<{ factor: number; ms: number }>;
}
