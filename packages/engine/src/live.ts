import type { EpisodeSpec, TwinAdapter } from "@sonata/core";
import { createAdapters, type AdapterSetOptions } from "./adapters";
import type { Director } from "./director";
import {
  createSession,
  realMsPerTick,
  simHoursPerRealMinute,
  type Session,
  type SessionRecord,
  type SessionState,
  type SessionTimer,
} from "./session";

// PLUGGING A REAL AGENT IN.
//
// `./session` is the machinery; this is the one place it meets real time. Two
// things live here and nothing else:
//
//   - `realTimer`, the `setTimeout` implementation of `SessionTimer`. It is the
//     only wall-clock dependency in the whole session path, which is what lets
//     every test run a simulated day in a millisecond.
//   - `sessionRegistry`, because a session outlives the request that started it.
//     An HTTP surface is stateless per call and the world is not: start returns
//     an id, and status/stop find the day again by that id.
//
// The session itself never talks to the agent, and there is nothing here that
// does either. The agent connects to the twins on their own ports, through their
// own public APIs, and this module never learns it exists.

// ---------------------------------------------------------------------------
// Real time
// ---------------------------------------------------------------------------

/** `SessionTimer` over `Date.now` and `setTimeout`. */
export function realTimer(): SessionTimer {
  return {
    now: () => Date.now(),
    schedule(ms, fn) {
      // Deliberately NOT unref'd. A session is the process's reason to be awake;
      // letting Node exit between two ticks would strand the day half-run.
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    },
  };
}

/** One simulated hour a real minute — a workday in eight minutes. */
export const DEFAULT_COMPRESSION = simHoursPerRealMinute(1);

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

export interface LiveSessionOptions {
  spec: EpisodeSpec;
  /**
   * Where the twins are. Omitted, the adapters point at the local defaults, which
   * is what a laptop run wants.
   */
  twins?: AdapterSetOptions;
  /** Overrides `twins` entirely — for a caller that has already built adapters. */
  adapters?: TwinAdapter[];
  /** See `realMsPerTick`. Defaults to one simulated hour a real minute. */
  compression?: number;
  sessionId?: string;
  director?: Director;
  /** What to call the external agent on the artifact, e.g. "openclaw@laptop". */
  agentLabel?: string;
  seedWorld?: boolean;
  resetTwins?: boolean;
  idleTicks?: number;
  timer?: SessionTimer;
}

/**
 * A session on the wall clock, started.
 *
 * `start` is awaited here, so by the time this resolves the world has been seeded,
 * tick 0 has fired and the day is running. An agent pointed at the twins from
 * this moment on will find a day already in progress, which is exactly what it
 * would find on a real Monday.
 */
export async function startLiveSession(opts: LiveSessionOptions): Promise<Session> {
  const session = createSession({
    spec: opts.spec,
    adapters: opts.adapters ?? createAdapters(opts.twins),
    compression: opts.compression ?? DEFAULT_COMPRESSION,
    timer: opts.timer ?? realTimer(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.director ? { director: opts.director } : {}),
    ...(opts.agentLabel ? { agentLabel: opts.agentLabel } : {}),
    ...(opts.seedWorld === undefined ? {} : { seedWorld: opts.seedWorld }),
    ...(opts.resetTwins === undefined ? {} : { resetTwins: opts.resetTwins }),
    ...(opts.idleTicks === undefined ? {} : { idleTicks: opts.idleTicks }),
  });
  await session.start();
  return session;
}

/**
 * How long a session will take in real time, so an operator is told before they
 * commit an afternoon to it.
 */
export function sessionDurationMs(spec: EpisodeSpec, compression: number): number {
  return spec.clock.ticks * realMsPerTick(spec.clock, compression);
}

// ---------------------------------------------------------------------------
// Keeping track of them
// ---------------------------------------------------------------------------

export interface SessionRegistry {
  add(session: Session): Session;
  get(id: string): Session | undefined;
  list(): SessionState[];
  /** Stop one and take it off the list, returning its record. */
  stop(id: string, reason?: string): Promise<SessionRecord | undefined>;
  /** Stop every live session — for a clean shutdown. */
  stopAll(reason?: string): Promise<SessionRecord[]>;
}

export function createSessionRegistry(): SessionRegistry {
  const live = new Map<string, Session>();
  return {
    add(session) {
      live.set(session.id, session);
      // Dropped from the map when the day ends of its own accord, so a long-lived
      // process does not accumulate finished worlds. The record has already gone
      // to whoever was awaiting `finished`.
      void session.finished().then(() => live.delete(session.id));
      return session;
    },
    get: (id) => live.get(id),
    list: () => [...live.values()].map((s) => s.status(0)),
    async stop(id, reason) {
      const session = live.get(id);
      if (!session) return undefined;
      const record = await session.stop(reason);
      live.delete(id);
      return record;
    },
    async stopAll(reason) {
      const all = [...live.values()];
      const records: SessionRecord[] = [];
      for (const session of all) {
        records.push(await session.stop(reason));
        live.delete(session.id);
      }
      return records;
    },
  };
}

/**
 * The process-wide registry.
 *
 * Hung off `globalThis` for the same reason the twins hang their database there:
 * Next reloads a route module on every edit in dev, and a fresh Map per reload
 * would lose a running day the first time someone saved a file.
 */
export function sessionRegistry(): SessionRegistry {
  const g = globalThis as { __sonataSessions?: SessionRegistry };
  if (!g.__sonataSessions) g.__sonataSessions = createSessionRegistry();
  return g.__sonataSessions;
}
