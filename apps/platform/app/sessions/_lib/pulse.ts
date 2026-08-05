import type { AgentPulse, SessionView } from "../../api/sessions/_lib/types";

// IS THE AGENT DOING ANYTHING?
//
// The one question a session has to answer at a glance, and the one a run never
// has to ask: a run's agent is called every tick, so it is always working. Here
// the agent is somebody else's process, and the failure that matters most is not
// a bad reply — it is silence. An agent that never connected, an MCP server
// pointed at the wrong port and an agent that read the morning and decided to do
// nothing all look identical in a timeline, so the difference is stated in
// words rather than left to be inferred from a gap between rows.
//
// Pure and free of React, so the live view and the sessions list read the same
// state from the same numbers, and so the wording can be reasoned about on its
// own.

export type PulseTone = "running" | "passed" | "neutral" | "failed";

export interface PulseRead {
  pulse: AgentPulse;
  /** The headline, in the user's language. */
  title: string;
  /** One sentence under it, with the evidence in it. */
  detail: string;
  tone: PulseTone;
}

const ENDED = new Set(["done", "failed", "aborted"]);

/** "45 minutes", "2 hours" — simulated time, the clock the day is on. */
function simSpan(minutes: number): string {
  if (minutes < 60) return `${minutes} simulated minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rounded} simulated hour${hours === 1 ? "" : "s"}`;
}

/** "just now", "12s ago", "3m ago". Finer than `ago`, because seconds matter here. */
export function sinceLabel(at: number | null, now: number): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function readPulse(view: SessionView, now: number): PulseRead {
  const actions = view.agentActions;
  // Two numbers, deliberately not merged: what the clones logged, and whether
  // the agent was heard from at all. A hand-back the harness reported changes
  // nothing in the world and is still not silence.
  const changes =
    actions === 0
      ? "Nothing in the clones has changed"
      : `${actions} thing${actions === 1 ? "" : "s"} changed across the clones`;
  const heard = view.lastAgentActionAt !== null;

  if (ENDED.has(view.status)) {
    return {
      pulse: "ended",
      title: heard ? "The day is over" : "The agent never did anything",
      detail: heard
        ? `${changes} over ${view.tick} interval${view.tick === 1 ? "" : "s"}, the longest silence being ${simSpan(view.longestIdleStreak * view.simMinutesPerTick)}.`
        : "Nothing in the clones changed while the world was running. Either nothing was connected, or the agent read the day and left it alone.",
      tone: heard ? "passed" : "neutral",
    };
  }

  if (view.status === "queued" || view.tick === 0) {
    return {
      pulse: "starting",
      title: "Standing the world up",
      detail:
        "The clones are being reset and loaded. Point your agent at them now — the first emails land as soon as the day starts.",
      tone: "neutral",
    };
  }

  if (!heard) {
    return {
      pulse: "idle",
      title: "Nothing from the agent yet",
      detail: `The world has played ${view.tick} interval${view.tick === 1 ? "" : "s"} and no clone has recorded a single change. If the agent is meant to be connected, check it is working against the addresses below.`,
      tone: "failed",
    };
  }

  if (view.idleStreak === 0) {
    return {
      pulse: "acting",
      title: "The agent is working",
      detail: `${changes}. The last thing it did was ${sinceLabel(view.lastAgentActionAt, now)}.`,
      tone: "running",
    };
  }

  return {
    pulse: "idle",
    title: `Quiet for ${simSpan(view.idleStreak * view.simMinutesPerTick)}`,
    detail: `${changes} so far. The last thing the agent did was ${sinceLabel(view.lastAgentActionAt, now)}. Silence is a finding, not a fault — the day keeps running either way.`,
    tone: "neutral",
  };
}

/**
 * Seconds until the next tick, or null when nothing is scheduled.
 *
 * The world moves on its own timer, so a page with no countdown looks frozen
 * between beats — at real time that is fifteen minutes of a page that appears to
 * have died.
 */
export function nextTickIn(view: SessionView, now: number): number | null {
  if (view.nextTickAt === null) return null;
  return Math.max(0, Math.round((view.nextTickAt - now) / 1000));
}

/**
 * How often to ask. Tied to the world's own rate: nothing new can exist between
 * ticks except the agent's work, which is only read at a tick boundary anyway.
 */
export function pollIntervalMs(realMsPerTick: number): number {
  return Math.min(10_000, Math.max(1_000, Math.round(realMsPerTick / 4)));
}

/** "an hour a minute" — the compression, said the way an operator chose it. */
export function compressionLabel(factor: number): string {
  if (factor === 1) return "real time";
  if (factor >= 3600) return "a day in seconds";
  const simHoursPerRealMinute = (factor * 60) / 3600;
  if (simHoursPerRealMinute >= 1) {
    const n = Number.isInteger(simHoursPerRealMinute)
      ? String(simHoursPerRealMinute)
      : simHoursPerRealMinute.toFixed(1);
    return `${n} simulated hour${simHoursPerRealMinute === 1 ? "" : "s"} a minute`;
  }
  // Below an hour a minute the sentence reads better the other way up: how much
  // real time one simulated hour costs you.
  return `${Math.round(1 / simHoursPerRealMinute)} real minutes a simulated hour`;
}

/** "8m 20s" — a real-time duration, for the estimate before you commit to one. */
export function realDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  // A round figure keeps its round shape: "6m", not "6m 0s".
  if (minutes < 90) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}
