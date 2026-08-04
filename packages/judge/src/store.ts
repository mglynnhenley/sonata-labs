import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EpisodeJudgeReport } from "@sonata/core";

// Read/write side of the judge artifact. It lives beside the run artifact, sharing
// its base name, so a run's files stay discoverable from the run id alone — and so
// re-judging is a matter of overwriting one file.
//
// The runs directory is a parameter rather than a module constant: the dashboard,
// the CLI and the benchmark runner each own where their runs live, and a judge that
// picked the location would make itself un-embeddable.

/**
 * The judge artifact's suffix.
 *
 * CRITICAL for whoever lists runs: `<runId>.judge.json` ends `.json` too, so any
 * "every .json in this directory is a run" scan will pick judge artifacts up and
 * render them as garbage rows. Exported as a named const precisely so those callers
 * can import and exclude it rather than re-typing the literal.
 */
export const JUDGE_SUFFIX = ".judge.json";

/** A run id is a filename base, and it can arrive from a URL — never trust it. */
const SAFE_RUN_ID = /^[\w.-]+$/;

/** Absolute path of a run's judge artifact, or null when the id is not a safe base. */
export function judgePath(dir: string, runId: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, `${runId}${JUDGE_SUFFIX}`);
  // Belt and braces: even an id that passes the pattern must land inside `dir`.
  return file.startsWith(root + path.sep) ? file : null;
}

/** Write the judge artifact beside its run. Overwrites — re-judging is the point. */
export function writeJudgeReport(dir: string, report: EpisodeJudgeReport): string {
  const file = judgePath(dir, report.runId);
  // Unlike the read path, a bad id here is a harness bug, not hostile input — the id
  // came off an artifact we wrote. Fail loudly rather than silently skipping the write.
  if (!file) throw new Error(`Refusing to write a judge report for unsafe run id "${report.runId}"`);
  mkdirSync(path.resolve(dir), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function readJudgeReport(dir: string, runId: string): EpisodeJudgeReport | null {
  const file = judgePath(dir, runId);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EpisodeJudgeReport;
  } catch {
    return null; // absent, unreadable, or half-written
  }
}

/** Run ids that already have a judge artifact — what a `--rejudge` flag checks. */
export function listJudged(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(path.resolve(dir));
  } catch {
    return []; // no runs yet
  }

  return names
    .filter((n) => n.endsWith(JUDGE_SUFFIX))
    .map((n) => n.slice(0, -JUDGE_SUFFIX.length))
    .sort((a, b) => b.localeCompare(a)); // newest first — ids are timestamps
}
