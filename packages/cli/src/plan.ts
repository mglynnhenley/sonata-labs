import type { PortState } from "./diagnose";

// What `up` and `down` decide, with nothing running.
//
// Both commands have to be safe to run twice, and the whole of "safe to run
// twice" lives in these two functions: what is on the port, and whether Sonata
// is the one that put it there. Everything else is spawning and waiting.

export interface AppContext {
  label: string;
  port: number;
  /** "sonata up gmail" — the command that would start this one on its own. */
  startCommand: string;
}

export type StartPlan =
  | { action: "reuse"; reason: string }
  | { action: "wait"; reason: string }
  | { action: "start" }
  | { action: "refuse"; reason: string; fix: string };

/**
 * Whether to spawn.
 *
 * `managedPid` is a live process Sonata started and still remembers. It is the
 * difference between "not answering yet" and "not running": Next's first compile
 * takes seconds, and a second `next dev` started in that window dies on
 * EADDRINUSE and takes the log with it.
 */
export function planStart(state: PortState, managedPid: number | null, ctx: AppContext): StartPlan {
  if (state.kind === "sonata") {
    return {
      action: "reuse",
      reason: managedPid
        ? `already serving (pid ${managedPid}) — ${state.detail}`
        : `already serving — ${state.detail} (started outside Sonata; left alone)`,
    };
  }

  if (managedPid !== null) {
    if (state.kind === "sonata-broken") {
      return {
        action: "refuse",
        reason: `running (pid ${managedPid}) but ${state.detail}`,
        fix: "sonata doctor   — its database is usually behind its schema",
      };
    }
    return { action: "wait", reason: `starting (pid ${managedPid}) — waiting for health` };
  }

  switch (state.kind) {
    case "free":
      return { action: "start" };
    case "foreign":
      return {
        action: "refuse",
        reason: `taken by something else — ${state.detail}`,
        fix: `free it: lsof -ti tcp:${ctx.port} | xargs kill   — then ${ctx.startCommand}`,
      };
    case "sonata-broken":
      return {
        action: "refuse",
        reason: `something is already on port ${ctx.port} and ${state.detail}`,
        fix: "sonata doctor   — starting a second one here would only die on EADDRINUSE",
      };
  }
}

export type StopPlan =
  | { action: "stop"; pid: number }
  | { action: "nothing"; reason: string }
  | { action: "cannot"; reason: string; fix: string };

/**
 * Whether to signal.
 *
 * Sonata stops what Sonata started and nothing else. A dev server someone is
 * watching in their own terminal is theirs — killing it from here would be a
 * surprise arriving from a different window.
 */
export function planStop(state: PortState, managedPid: number | null, ctx: AppContext): StopPlan {
  if (managedPid !== null) return { action: "stop", pid: managedPid };

  switch (state.kind) {
    case "free":
      return { action: "nothing", reason: "already stopped" };
    case "sonata":
      return {
        action: "cannot",
        reason: `up on port ${ctx.port}, but Sonata did not start it`,
        fix: `stop it where you started it (Ctrl-C in that terminal), or: lsof -ti tcp:${ctx.port} | xargs kill`,
      };
    case "sonata-broken":
    case "foreign":
      return {
        action: "cannot",
        reason: `something Sonata did not start — ${state.detail}`,
        fix: `lsof -ti tcp:${ctx.port} | xargs kill`,
      };
  }
}
