import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EpisodeRun } from "@sonata/core";
import { JUDGE_SUFFIX } from "@sonata/judge";
import type { BenchmarkReport } from "./run";

// Where a benchmark's artifacts live. One file per cell plus one aggregate, all
// in a directory the caller owns — the dashboard, the CLI and a scratch tmpdir in
// a test each pick their own, so nothing here hard-codes a location.

/** A finished episode: `<runId>.json`. */
export const RUN_SUFFIX = ".json";

/** The whole matrix's aggregate: `<benchmarkId>.benchmark.json`. */
export const BENCHMARK_SUFFIX = ".benchmark.json";

/** Same rule as @sonata/judge: a run id is a filename base, so constrain it. */
const SAFE_ID = /^[\w.-]+$/;

function safeJoin(dir: string, name: string): string | null {
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  return file.startsWith(root + path.sep) ? file : null;
}

/** Absolute path of a cell's artifact, or null when the id is not a safe base. */
export function runPath(dir: string, runId: string): string | null {
  return SAFE_ID.test(runId) ? safeJoin(dir, `${runId}${RUN_SUFFIX}`) : null;
}

/** Absolute path of the aggregate artifact, or null when the id is unsafe. */
export function reportPath(dir: string, benchmarkId: string): string | null {
  return SAFE_ID.test(benchmarkId) ? safeJoin(dir, `${benchmarkId}${BENCHMARK_SUFFIX}`) : null;
}

export function writeRunArtifact(dir: string, run: EpisodeRun): string {
  const file = runPath(dir, run.runId);
  // A bad id here is a harness bug, not hostile input — it came off a plan we
  // built. Fail loudly rather than skipping the write and losing an hour's spend.
  if (!file) throw new Error(`Refusing to write a run artifact for unsafe id "${run.runId}"`);
  mkdirSync(path.resolve(dir), { recursive: true });
  writeFileSync(file, JSON.stringify(run, null, 2));
  return file;
}

export function readRunArtifact(dir: string, runId: string): EpisodeRun | null {
  const file = runPath(dir, runId);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EpisodeRun;
  } catch {
    return null; // absent, unreadable, or half-written — treat as not run
  }
}

export function writeReport(dir: string, report: BenchmarkReport): string {
  const file = reportPath(dir, report.matrix.id);
  if (!file) throw new Error(`Refusing to write a report for unsafe id "${report.matrix.id}"`);
  mkdirSync(path.resolve(dir), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function readReport(dir: string, benchmarkId: string): BenchmarkReport | null {
  const file = reportPath(dir, benchmarkId);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BenchmarkReport;
  } catch {
    return null;
  }
}

/**
 * Run ids with an artifact on disk — what `planMatrix` skips.
 *
 * Both sibling suffixes end `.json`, so a naive "every .json is a run" scan picks
 * up `<runId>.judge.json` and `<benchmarkId>.benchmark.json` and invents run ids
 * ending "…​.judge". Excluding them is why both constants are exported, here and
 * from @sonata/judge.
 */
export function listRunIds(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(path.resolve(dir));
  } catch {
    return []; // nothing has run yet
  }

  return names
    .filter(
      (n) => n.endsWith(RUN_SUFFIX) && !n.endsWith(JUDGE_SUFFIX) && !n.endsWith(BENCHMARK_SUFFIX),
    )
    .map((n) => n.slice(0, -RUN_SUFFIX.length))
    .sort();
}
