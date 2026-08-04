import type {
  AgentTrace,
  EpisodeRun,
  EpisodeSpec,
  RunCost,
  TickRecord,
  TwinAuditRow,
  TwinHealth,
  TwinName,
} from "@sonata/core";

// The contract between the dashboard and @sonata/engine, written down in one
// place so the dashboard depends on a shape rather than on a package's current
// spelling. Everything else in this folder — the registry, the db streaming, the
// artifact, the benchmark wiring — is written against `RunEpisodeFn` and would
// survive the engine reorganising itself entirely.
//
// It is also the seam that lets the bridge be driven with a stub loop, the same
// way @sonata/benchmark takes its runner as a port and for the same reason.

export interface EngineRunOptions {
  spec: EpisodeSpec;
  /** Chosen by the caller: a dashboard run id, or a benchmark's deterministic cell id. */
  runId: string;
  /** OpenRouter slug of the model under test. */
  model: string;
  /**
   * Model the harness itself runs on. Held apart from `model` because the
   * benchmark varies the agent and must not let the world change with it.
   */
  directorModel?: string;
  /** Surfaces to attach — the twins the spec actually uses. */
  twins: TwinName[];
  /** Where each of those twins is listening. */
  twinUrls: Partial<Record<TwinName, string>>;
  /** Reset the twins and load the world before tick 0. */
  seedWorld?: boolean;
  /**
   * Called as each tick completes. The dashboard's live channel hangs off this,
   * and throwing from it is how a run is stopped early — see `cancel`.
   */
  onTick?: (record: TickRecord) => void;
}

export interface EngineRunResult {
  run: EpisodeRun;
  /** Every model call, verbatim. Written beside the artifact for the cost breakdown. */
  trace: AgentTrace;
  /**
   * Every twin's audit rows for the run, ascending. The checklist's ground
   * truth: a criterion about what the agent *did* is answered from here, not
   * from what it said it did.
   */
  audit: TwinAuditRow[];
  cost: RunCost;
  /** What each twin said when the run asked if it was up. */
  preflight: TwinHealth[];
}

export type RunEpisodeFn = (opts: EngineRunOptions) => Promise<EngineRunResult>;
