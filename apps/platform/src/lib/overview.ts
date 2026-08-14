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
import { listCompanies } from "./engine/clone";
import { getSettings } from "./settings";
import { allTwinStatuses, type TwinStatus } from "./twins";
import type { ModelRole } from "./models";

// One payload behind the whole shell. Home and the sidebar both poll it, so the
// page never goes stale and there is never a refresh button — and one endpoint
// means one round trip rather than four racing each other every two seconds.

export interface Overview {
  /** No day played yet ⇒ Home shows the welcome instead of the dashboard. */
  firstRun: boolean;
  counts: { worlds: number; episodes: number; runs: number };
  /** Queued, running or judging — newest first. */
  live: RunSummary[];
  /** The last handful of runs, whatever their state. */
  recent: RunSummary[];
  stats: RunStats;
  twins: TwinStatus[];
  /**
   * The company currently loaded into the three clones, if any. Home titles
   * itself after it — the dashboard is a view of ONE cloned business, and
   * naming it beats a generic "What's happening".
   */
  clone: { name: string; seededAt: number } | null;
  /** Median simulated minutes reached before a run stopped. Null until a run
   *  has been scored — the clock's minutes-per-tick applied to `medianTicks`. */
  medianHorizonMin: number | null;
  models: Record<ModelRole, string>;
  /** Server time when this was built, so the client can age it honestly. */
  at: number;
}

export async function getOverview(): Promise<Overview> {
  const worlds = countWorlds();
  const runs = countRuns();
  const twins = await allTwinStatuses();
  return {
    // Keyed on runs alone: someone who clones a company without playing a day
    // has not seen the product yet, and must not lose the explainer for it.
    firstRun: runs === 0,
    counts: { worlds, episodes: countEpisodes(), runs },
    live: listLiveRuns(),
    recent: listRuns({ limit: 6 }),
    stats: runStats(),
    twins,
    medianHorizonMin: (() => {
      const stats = runStats();
      return stats.medianTicks === null
        ? null
        : Math.round(stats.medianTicks * getSettings().simMinutesPerTick);
    })(),
    clone: (() => {
      const seeded = listCompanies().find((company) => company.state === "seeded");
      // `seededAt` is non-null exactly when state is "seeded", but the type does
      // not know that, so the guard is real rather than an assertion.
      return seeded && seeded.seededAt !== null
        ? { name: seeded.name, seededAt: seeded.seededAt }
        : null;
    })(),
    models: getSettings().models,
    at: Date.now(),
  };
}
