import type { RunCost, RunStatus, Termination, TickRecord, TwinName } from "@sonata/core";

// Product evaluation contracts. Inspect owns tested-agent execution; Sonata owns the workplace.
export { startEpisode, runEpisodeToCompletion, status, whenDone, liveRuns, cancel, reconcileRuns } from "./inspect";
export { explainUnpaired } from "./capture";

export interface StartEpisodeInput {
  /** A saved scenario's id, or enough of its title to be unambiguous. */
  episodeId: string;
  /** OpenRouter slug of the model under test. Defaults to the Settings choice. */
  model?: string;
  /** Surfaces to attach. Defaults to the ones the scenario actually uses. */
  twins?: TwinName[];
  /** Length of the simulated day. Defaults to the scenario's own clock. */
  ticks?: number;
  /**
   * Raise (or lower) this run's stop guards, leaving the saved scenario alone.
   *
   * Exists because a guard sized for a shorter day silently truncates a longer
   * one, and a truncated day cannot be graded against a whole checklist without
   * charging our interruption to the agent. When the answer a run has to give is
   * "what does this model do across the WHOLE day", the budget has to be allowed
   * to say so out loud — and it is merged into the spec the artifact is filed
   * with, so a reader months later sees the guards that were actually in force
   * rather than the ones the scenario was saved with.
   */
  termination?: Partial<Termination>;
  /** Judge the day when it ends. On by default — a run without a diagnosis is half a result. */
  judge?: boolean;
  judgeModel?: string;
  directorModel?: string;
  /** Reset and reload the twins before tick 0. */
  seedWorld?: boolean;
  /**
   * Repeat index for a benchmark cell. Two runs of the same spec on the same
   * model differ by the provider's own sampling, which is what the seeds in a
   * matrix are measuring — so this names the repeat rather than steering it.
   */
  seed?: number;
  /** Chosen by the caller when it needs a deterministic id — see @sonata/benchmark. */
  runId?: string;
  /** Explicit address of the platform that owns the workplace. */
  platformUrl?: string;
  compression?: number;
  timing?: import("@sonata/core").SessionTimingPolicy;
  /** Disable reactive colleagues only for a declared diagnostic run. */
  director?: boolean;
}

/** One run as every polling surface sees it. */
export interface RunView {
  runId: string;
  episodeId: string;
  title: string;
  model: string;
  status: RunStatus;
  /** Ticks recorded so far. */
  tick: number;
  plannedTicks: number;
  /**
   * The surfaces this run attached — narrowed from the scenario's by the caller,
   * so it is the run's own answer rather than the scenario's.
   */
  twins: TwinName[];
  /** Simulated time at the head of the story. Drives the live clock. */
  simTimeISO: string;
  lastEvent: string | null;
  startedAt: number;
  endedAt: number | null;
  score: number | null;
  autonomy: number | null;
  /**
   * What the day cost, in full.
   *
   * Summed from the run's own trace when the loop returns, so it is null while
   * the day plays rather than a running $0.00 that reads as "free". A day that
   * was stopped or that crashed still has one — it was paid either way — and it
   * is the only place that figure survives for a run with no verdict.
   */
  cost: RunCost | null;
  error: string | null;
  /** True while this process still holds the run in memory. */
  live: boolean;
}

/** Poll response. `ticks` carries only what the caller has not seen. */
export interface RunPoll {
  run: RunView;
  ticks: TickRecord[];
  /** Pass back as the next `sinceTick`. */
  nextSinceTick: number;
}
