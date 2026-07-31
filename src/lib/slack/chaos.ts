// Fault injection. A replica that never fails teaches false confidence: an
// agent that passes here can still break on real Slack's 429s, transient
// 5xx-equivalents, and slow calls. This layer lets you turn those on
// deliberately and observe how the agent-under-test copes.
//
// Everything is DETERMINISTIC given a seed: the same seed + the same sequence
// of calls injects the same faults, so a failing agent run is reproducible.

export interface RateLimitConfig {
  enabled: boolean;
  /** Requests allowed per window, per method tier. Slack tier-3 ≈ 50/min. */
  capacity: number;
  windowSec: number;
  /** Value returned in the Retry-After header. */
  retryAfterSec: number;
}

export interface ChaosConfig {
  enabled: boolean;
  /** Fixed delay added to every call, in ms. */
  latencyMs: number;
  /** Extra uniformly-random delay 0..jitterMs. */
  jitterMs: number;
  /** Probability (0..1) that a call fails with `errorCode`. */
  errorRate: number;
  errorCode: string;
  /** Deterministic per-method outages: method → Slack error code. */
  failures: Record<string, string>;
  rateLimit: RateLimitConfig;
  /** Seed for the PRNG driving errorRate/jitter. */
  seed: number;
}

export const DEFAULT_CHAOS: ChaosConfig = {
  enabled: false,
  latencyMs: 0,
  jitterMs: 0,
  errorRate: 0,
  errorCode: "service_unavailable",
  failures: {},
  rateLimit: { enabled: false, capacity: 50, windowSec: 60, retryAfterSec: 30 },
  seed: 1,
};

interface Bucket {
  tokens: number;
  windowStart: number;
}

interface ChaosState {
  config: ChaosConfig;
  /** PRNG cursor — advances once per evaluated call. */
  tick: number;
  buckets: Map<string, Bucket>;
  /** Rolling record of what was injected, for the activity panel. */
  log: InjectedFault[];
}

export interface InjectedFault {
  ts: number;
  method: string;
  kind: "error" | "ratelimited" | "outage" | "latency";
  detail: string;
}

// Stored on globalThis so Next's HMR and every route handler share one state.
const g = globalThis as unknown as { __slackSandboxChaos?: ChaosState };
if (!g.__slackSandboxChaos) {
  g.__slackSandboxChaos = {
    config: structuredClone(DEFAULT_CHAOS),
    tick: 0,
    buckets: new Map(),
    log: [],
  };
}
const state = g.__slackSandboxChaos;

export function getChaos(): ChaosConfig {
  return state.config;
}

export function setChaos(patch: Partial<ChaosConfig>): ChaosConfig {
  state.config = {
    ...state.config,
    ...patch,
    rateLimit: { ...state.config.rateLimit, ...(patch.rateLimit ?? {}) },
    failures: patch.failures ?? state.config.failures,
  };
  // Reconfiguring resets the deterministic stream and the buckets so a run
  // always starts from a known point.
  state.tick = 0;
  state.buckets.clear();
  return state.config;
}

export function resetChaos(): ChaosConfig {
  state.config = structuredClone(DEFAULT_CHAOS);
  state.tick = 0;
  state.buckets.clear();
  state.log = [];
  return state.config;
}

export function recentFaults(limit = 100): InjectedFault[] {
  return state.log.slice(-limit);
}

function record(fault: InjectedFault): void {
  state.log.push(fault);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Slack buckets rate limits per method family (chat.* is its own tier, etc.),
 * so a burst of postMessage shouldn't starve conversations.history.
 */
function tierOf(method: string): string {
  return method.split(".")[0];
}

export interface ChaosVerdict {
  /** Milliseconds to sleep before handling (0 = none). */
  delayMs: number;
  /** When set, short-circuit with this Slack error instead of handling. */
  error?: { code: string; rateLimited?: boolean; retryAfterSec?: number };
}

/**
 * Decide what (if anything) to inject for this call. Advances the deterministic
 * stream exactly once per call so replays line up.
 */
export function evaluateChaos(method: string, now = Date.now()): ChaosVerdict {
  const c = state.config;
  if (!c.enabled) return { delayMs: 0 };

  const n = state.tick++;

  // 1. Deterministic scoped outage — a named method always fails.
  const outage = c.failures[method];
  if (outage) {
    record({ ts: now, method, kind: "outage", detail: outage });
    return { delayMs: 0, error: { code: outage } };
  }

  // 2. Rate limit (token bucket per tier). Checked before random errors so a
  //    saturated bucket reports honestly rather than being masked.
  if (c.rateLimit.enabled) {
    const key = tierOf(method);
    const windowMs = c.rateLimit.windowSec * 1000;
    let bucket = state.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { tokens: c.rateLimit.capacity, windowStart: now };
      state.buckets.set(key, bucket);
    }
    if (bucket.tokens <= 0) {
      record({ ts: now, method, kind: "ratelimited", detail: `tier ${key}` });
      return {
        delayMs: 0,
        error: {
          code: "ratelimited",
          rateLimited: true,
          retryAfterSec: c.rateLimit.retryAfterSec,
        },
      };
    }
    bucket.tokens -= 1;
  }

  // 3. Random transient error.
  if (c.errorRate > 0 && rand(c.seed + n) < c.errorRate) {
    record({ ts: now, method, kind: "error", detail: c.errorCode });
    return { delayMs: 0, error: { code: c.errorCode } };
  }

  // 4. Latency.
  const jitter = c.jitterMs > 0 ? Math.floor(rand(c.seed + n + 100000) * c.jitterMs) : 0;
  const delayMs = c.latencyMs + jitter;
  if (delayMs > 0) record({ ts: now, method, kind: "latency", detail: `${delayMs}ms` });
  return { delayMs };
}
