import {
  countEpisodes,
  countRuns,
  countWorlds,
  listLiveRuns,
  listRuns,
  runStats,
  type RunStats,
  type RunSummary,
} from "./db";
import { getSettings } from "./settings";
import { allTwinStatuses, type TwinStatus } from "./twins";
import type { ModelRole } from "./models";

// One payload behind the whole shell. Home and the sidebar both poll it, so the
// page never goes stale and there is never a refresh button — and one endpoint
// means one round trip rather than four racing each other every two seconds.

export interface Overview {
  /** Nothing cloned yet ⇒ Home shows the welcome instead of the dashboard. */
  firstRun: boolean;
  counts: { worlds: number; episodes: number; runs: number };
  /** Queued, running or judging — newest first. */
  live: RunSummary[];
  /** The last handful of runs, whatever their state. */
  recent: RunSummary[];
  stats: RunStats;
  twins: TwinStatus[];
  models: Record<ModelRole, string>;
  /** Server time when this was built, so the client can age it honestly. */
  at: number;
}

export async function getOverview(): Promise<Overview> {
  const worlds = countWorlds();
  const runs = countRuns();
  const twins = await allTwinStatuses();
  return {
    firstRun: worlds === 0 && runs === 0,
    counts: { worlds, episodes: countEpisodes(), runs },
    live: listLiveRuns(),
    recent: listRuns({ limit: 6 }),
    stats: runStats(),
    twins,
    models: getSettings().models,
    at: Date.now(),
  };
}
