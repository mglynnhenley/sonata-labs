import { episodeTwins, plannedTicks, type EpisodeSpec, type WorldSeed } from "@sonata/core";
import type { GeneratedWorld } from "@sonata/world";
import { mirrorEpisode, mirrorWorld } from "./mirror";
import { deleteDoc, getDoc, listDocs, newId, putDoc } from "./store";
import type { RunDoc } from "./runner";
import type { EpisodeRecord, EpisodeSummary, WorldCounts, WorldRecord, WorldSummary } from "./types";

// Reading and writing the two things a user owns: the businesses they cloned and
// the scenarios they saved. Runs live in runner.ts, which owns their lifecycle.

export function saveWorld(
  seed: WorldSeed,
  brief: string,
  counts: WorldCounts,
  clone?: GeneratedWorld,
): WorldRecord {
  const record: WorldRecord = {
    id: newId("wld"),
    name: seed.business.name,
    description: seed.business.description,
    brief,
    createdAt: Date.now(),
    counts,
    seed,
    ...(clone ? { clone } : {}),
  };
  putDoc("world", record.id, record);
  mirrorWorld(record);
  return record;
}

export function getWorld(id: string): WorldRecord | undefined {
  return getDoc<WorldRecord>("world", id);
}

export function listWorlds(): WorldSummary[] {
  // The seed and the backlog are megabytes of prose between them; a list of
  // business cards must not carry either.
  return listDocs<WorldRecord>("world").map(
    ({ seed: _seed, clone: _clone, ...summary }) => summary,
  );
}

export function saveEpisode(
  spec: EpisodeSpec,
  world: { id: string; name: string },
  templateId: string | null,
): EpisodeRecord {
  const record: EpisodeRecord = {
    id: spec.id,
    title: spec.title,
    story: spec.story,
    task: spec.task,
    worldId: world.id,
    worldName: world.name,
    templateId,
    twins: episodeTwins(spec),
    counts: {
      beats: spec.beats.length,
      criteria: spec.success.checklist.length,
      ticks: plannedTicks(spec),
    },
    createdAt: Date.now(),
    lastRun: null,
    spec,
  };
  putDoc("episode", record.id, record);
  mirrorEpisode(record);
  return record;
}

export function getEpisode(id: string): EpisodeRecord | undefined {
  return getDoc<EpisodeRecord>("episode", id);
}

export function deleteEpisode(id: string): boolean {
  return deleteDoc("episode", id);
}

/**
 * Saved scenarios, newest first, each carrying its most recent run. The run is
 * joined in on read rather than denormalized onto the episode: a run's status
 * changes every second while it plays, and a stale badge on a scenario card is
 * the kind of small lie the dashboard cannot afford.
 */
export function listEpisodes(): EpisodeSummary[] {
  const latest = new Map<string, RunDoc>();
  for (const run of listDocs<RunDoc>("run")) {
    const seen = latest.get(run.specId);
    if (!seen || run.startedAt > seen.startedAt) latest.set(run.specId, run);
  }

  return listDocs<EpisodeRecord>("episode").map(({ spec: _spec, ...summary }) => {
    const run = latest.get(summary.id);
    return {
      ...summary,
      lastRun: run
        ? { runId: run.runId, status: run.status, score: run.score, startedAt: run.startedAt }
        : null,
    };
  });
}
