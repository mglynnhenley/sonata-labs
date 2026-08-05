import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  checklistScore,
  runExecution,
  verdictOutcome,
  type CriterionResult,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type RunCost,
} from "@sonata/core";
import { autonomy } from "@sonata/judge";
import {
  createRun,
  finishRun,
  getRun,
  saveEpisode as indexEpisode,
  saveWorld as indexWorld,
  updateRunProgress,
} from "@/lib/db";
import { listRuns as listArtifacts } from "../../results/_lib/artifacts";
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
 *
 * A run that did not execute is written down UNSCORED: no outcome, no score, no
 * autonomy, in the row and in the artifact alike. Those columns are nullable and
 * the null is the point — a zero would be averaged into every table that reads
 * them, and a crash has no performance to average.
 */
export function mirrorRunFinish(input: {
  run: EpisodeRun;
  spec: EpisodeSpec | null;
  checklist: CriterionResult[];
  /** Spend, for a run that has no verdict to carry it. A crash still costs money. */
  cost?: RunCost;
}): void {
  const { run, checklist } = input;
  const cost = run.verdict?.cost ?? input.cost ?? { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 };
  const execution = runExecution(run);

  // ONE verdict for both surfaces. The row Home reads and the artifact the
  // results page reads are written from the same object here, so the two pages
  // cannot disagree about the same run; deriving the row's autonomy separately is
  // exactly how they came to. The caller's verdict wins when it has one — it was
  // scored against the live twins and may already carry a judge report.
  const verdict: EpisodeVerdict | null = !execution.executed
    ? null
    : (run.verdict ?? {
        outcome: verdictOutcome(checklist),
        score: checklistScore(checklist),
        autonomy: autonomy(checklist, run.ticks).score,
        checklist,
        judge: null,
        cost,
      });

  quietly(`run ${run.runId}`, () =>
    finishRun({
      id: run.runId,
      status: run.status,
      ...(verdict
        ? { outcome: verdict.outcome, score: verdict.score, autonomy: verdict.autonomy }
        : {}),
      // Only when there is something to say: the column already holds whatever
      // the run reported as it went, and writing a 0 over it would lose it.
      ...(cost.usd > 0 ? { costUsd: cost.usd } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    }),
  );

  const spec = input.spec;
  if (!spec) return;
  quietly(`artifact for ${run.runId}`, () => {
    const dir = runsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const artifact: RunArtifact = { ...run, verdict, spec };
    writeFileSync(path.join(dir, `${run.runId}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  });
}

export interface Reconciled {
  runId: string;
  was: { score: number | null; autonomy: number | null };
  now: { score: number | null; autonomy: number | null };
}

/**
 * Bring every relational row back into line with its artifact.
 *
 * The row is an index, not the record. It caches the verdict so a runs list can
 * render without parsing megabytes, and that cache was written by whatever
 * checker was current the day the run ended — so the day the checker changes,
 * Home starts quoting a number the run's own page no longer computes. A card
 * printing 63% beside a page printing 75% is the same class of bug as scoring a
 * crash: two figures for one run, and the reader has no way to tell which lies.
 *
 * Idempotent, and driven by `listRuns`, which is exactly what the results pages
 * read — so after this runs there is one number per run by construction. Returns
 * only the rows it actually moved.
 */
export function reconcileRunRows(): Reconciled[] {
  const moved: Reconciled[] = [];
  for (const run of listArtifacts()) {
    const row = getRun(run.runId);
    if (!row) continue;
    const score = run.verdict?.score ?? null;
    const auto = run.verdict?.autonomy ?? null;
    const outcome = run.verdict?.outcome ?? null;
    if (row.score === score && row.autonomy === auto && row.outcome === outcome) continue;
    moved.push({
      runId: run.runId,
      was: { score: row.score, autonomy: row.autonomy },
      now: { score, autonomy: auto },
    });
    quietly(`row ${run.runId}`, () =>
      finishRun({
        id: run.runId,
        status: row.status,
        ...(outcome ? { outcome } : {}),
        ...(score === null ? {} : { score }),
        ...(auto === null ? {} : { autonomy: auto }),
        ...(row.error ? { error: row.error } : {}),
        endedAt: row.endedAt ?? run.endedAt ?? Date.now(),
      }),
    );
  }
  return moved;
}
