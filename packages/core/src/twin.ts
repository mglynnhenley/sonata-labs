import type { BeatBody, EpisodeSpec } from "./types/episode";
import type { JudgeStep, TwinDiff, TwinSnapshot } from "./types/judge";
import type { AgentTrace, InjectedRef } from "./types/run";
import type { TwinName, WorldSeed } from "./types/world";

// The contract each twin implements so the episode engine never knows which
// surface it is talking to. The engine's tick loop is: fire this tick's beats,
// let the agent work, ask the director what the world does back — and every one
// of those steps goes through this interface. Adding a fourth twin means writing
// one of these and nothing else.
//
// `diff` and `renderDiff` are deliberately pure: a finished run carries both
// snapshots, so it can be re-diffed and re-judged offline with no twin running.

export interface TwinHealth {
  name: TwinName;
  ok: boolean;
  /** Why it is unhealthy, or what version answered. Shown in the run preflight. */
  detail?: string;
}

/** One audit row, normalized across twins from each one's own audit table. */
export interface TwinAuditRow {
  id: number;
  twin: TwinName;
  ts: number;
  method: string;
  endpoint: string;
  actionType: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
}

export interface InjectContext {
  /**
   * Simulated time for this injection. The artefact is dated with this and never
   * with `Date.now()` — a message stamped with wall-clock time inside a simulated
   * 9am would make the whole day incoherent to the agent reading it.
   */
  atISO: string;
  /**
   * Resolve a beat `ref` to what a twin already created for it. This is how a
   * follow-up email threads onto the escalation, and how a `move` finds the event
   * the `invite` minted. Undefined when the named beat has not fired (or failed),
   * which the adapter must treat as "post it standalone", never as a crash.
   */
  resolve(ref: string): InjectedRef | undefined;
  world: WorldSeed;
}

export interface TwinAdapter {
  readonly name: TwinName;
  /** Origin of the running twin, e.g. "http://localhost:3101". */
  readonly baseUrl: string;

  /** Preflight. Never throws — an unreachable twin reports `ok: false`. */
  health(): Promise<TwinHealth>;

  /** Capture state through the same public API the agent uses. */
  snapshot(): Promise<TwinSnapshot>;

  /** Pure. Both arguments are this twin's own snapshots. */
  diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff;

  /** Pure. Plain text for the judge prompt and the results page. */
  renderDiff(diff: TwinDiff): string;

  /**
   * Play one scripted beat or improvised director event into the twin, and return
   * the handle for what it created so later beats and criteria can find it.
   */
  inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef>;

  /** Load the world into this twin. Runs after `reset`, before tick 0. */
  seed(spec: EpisodeSpec): Promise<void>;

  /** Back to the pristine snapshot, so the next run starts from the same state. */
  reset(): Promise<void>;

  /** This twin's own record of what the agent did, newer than `sinceId`. */
  auditSince(sinceId: number): Promise<TwinAuditRow[]>;

  /** Pure. Pull this twin's calls out of a run trace and shrink them for the judge. */
  projectTrace(trace: AgentTrace): JudgeStep[];
}
