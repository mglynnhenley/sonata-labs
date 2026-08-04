import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  autonomyScore,
  checklistScore,
  verdictOutcome,
  type CriterionResult,
  type EpisodeRun,
  type EpisodeSpec,
} from "@sonata/core";
import {
  createRun,
  finishRun,
  saveEpisode as indexEpisode,
  saveWorld as indexWorld,
  updateRunProgress,
} from "@/lib/db";
import type { EpisodeRecord, WorldRecord } from "./types";

// The document store in ./store is the record: a WorldSeed, an EpisodeSpec and a
// finished run are read whole or not at all. But three other surfaces of the
// dashboard read something else — Home and the sidebar poll the relational
// tables in src/lib/db.ts, and Results reads run artifacts out of data/runs. So
// every write here is mirrored to both.
//
// Every mirror is best-effort on purpose. It is an index, not the truth, and a
// failed index must never be the reason a user loses the scenario they just
// described. What it cannot do is fail silently in a way that matters: the
// document store has already been written by the time any of this runs.

function quietly(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[sonata] could not mirror ${what}:`, (err as Error).message);
  }
}

export function mirrorWorld(record: WorldRecord): void {
  quietly(`world ${record.id}`, () =>
    indexWorld({ id: record.id, seed: record.seed, prompt: record.brief, createdAt: record.createdAt }),
  );
}

export function mirrorEpisode(record: EpisodeRecord): void {
  quietly(`scenario ${record.id}`, () =>
    indexEpisode({
      worldId: record.worldId,
      spec: record.spec,
      twins: record.twins,
      ...(record.templateId ? { templateId: record.templateId } : {}),
      createdAt: record.createdAt,
    }),
  );
}

export function mirrorRunStart(input: {
  runId: string;
  episodeId: string;
  episodeTitle: string;
  worldName: string;
  model: string;
  totalTicks: number;
  startedAt: number;
}): void {
  quietly(`run ${input.runId}`, () =>
    createRun({
      id: input.runId,
      episodeId: input.episodeId,
      episodeTitle: input.episodeTitle,
      worldName: input.worldName,
      model: input.model,
      totalTicks: input.totalTicks,
      status: "running",
      startedAt: input.startedAt,
    }),
  );
}

export function mirrorRunProgress(
  runId: string,
  patch: { tick: number; simTime: string; lastEvent?: string },
): void {
  quietly(`run ${runId}`, () =>
    updateRunProgress(runId, {
      status: "running",
      tick: patch.tick,
      simTime: patch.simTime,
      ...(patch.lastEvent ? { lastEvent: patch.lastEvent } : {}),
    }),
  );
}

/** The `EpisodeRun` artifact, plus the spec that Results needs for the brief. */
interface RunArtifact extends EpisodeRun {
  spec: EpisodeSpec;
}

function runsDir(): string {
  return process.env.SONATA_RUNS_DIR ?? path.join(process.cwd(), "data", "runs");
}

/**
 * Terminal write. Results reads `data/runs/<runId>.json` rather than the
 * database, because a finished run has to be re-judgeable months later with
 * nothing live attached — so the artifact is written here, once, in full.
 */
export function mirrorRunFinish(input: {
  run: EpisodeRun;
  spec: EpisodeSpec | null;
  checklist: CriterionResult[];
}): void {
  const { run, checklist } = input;
  const score = checklistScore(checklist);
  const autonomy = autonomyScore(checklist, []);
  const outcome = verdictOutcome(checklist);
  const cost = run.verdict?.cost ?? { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 };

  quietly(`run ${run.runId}`, () =>
    finishRun({
      id: run.runId,
      status: run.status,
      outcome,
      score,
      autonomy,
      costUsd: cost.usd,
      ...(run.error ? { error: run.error } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    }),
  );

  const spec = input.spec;
  if (!spec) return;
  quietly(`artifact for ${run.runId}`, () => {
    const dir = runsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const artifact: RunArtifact = {
      ...run,
      verdict: { outcome, score, autonomy, checklist, judge: null, cost },
      spec,
    };
    writeFileSync(path.join(dir, `${run.runId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  });
}
