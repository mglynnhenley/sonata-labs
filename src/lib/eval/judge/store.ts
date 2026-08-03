import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runsDir } from "../report";
import type { JudgeReport } from "./types";

// Read/write side of the judge artifact. It lives beside the report and the trace,
// sharing their base name, so a run's three files stay discoverable from the run id
// alone — and so re-judging is a matter of overwriting one file.

/**
 * The judge artifact's suffix.
 *
 * CRITICAL: `runs.ts` `listRuns()` selects every file ending `.json` while excluding
 * `TRACE_SUFFIX`, then blind-casts each one to `EvalReport`. A `<runId>.judge.json`
 * ends `.json` too, so unless that filter also excludes this suffix, every judged run
 * shows up in the run list a second time as a garbage row. Exported as a named const
 * precisely so `runs.ts` can import and exclude it rather than re-typing the literal.
 */
export const JUDGE_SUFFIX = ".judge.json";

/**
 * A run id is a filename base, and it arrives from a URL — never trust it. Duplicated
 * from `runs.ts` rather than imported: those helpers are private there, and `runs.ts`
 * imports `JUDGE_SUFFIX` from this module, so reaching back would make the cycle
 * two-way. One regex is cheaper than a load-order hazard.
 */
const SAFE_RUN_ID = /^[\w.-]+$/;

function resolveJudge(runId: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const dir = runsDir();
  const file = path.resolve(dir, `${runId}${JUDGE_SUFFIX}`);
  // Belt and braces: even a run id that passes the pattern must land inside the
  // runs directory.
  return file.startsWith(dir + path.sep) ? file : null;
}

/** Write the judge artifact beside its report. Overwrites — re-judging is the point. */
export function writeJudge(report: JudgeReport): string {
  const dir = runsDir();
  mkdirSync(dir, { recursive: true });
  const file = resolveJudge(report.runId);
  // Unlike the read path, a bad id here is a harness bug, not hostile input — the id
  // came off an artifact we wrote. Fail loudly rather than silently skipping the write.
  if (!file) throw new Error(`Refusing to write judge for unsafe run id "${report.runId}"`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function readJudge(runId: string): JudgeReport | null {
  const file = resolveJudge(runId);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JudgeReport;
  } catch {
    return null; // absent, unreadable, or half-written
  }
}

/** Run ids that already have a judge artifact — what `--rejudge` is checked against. */
export function listJudged(): string[] {
  let names: string[];
  try {
    names = readdirSync(runsDir());
  } catch {
    return []; // no runs yet
  }

  return names
    .filter((n) => n.endsWith(JUDGE_SUFFIX))
    .map((n) => n.slice(0, -JUDGE_SUFFIX.length))
    .sort((a, b) => b.localeCompare(a)); // newest first — ids are timestamps
}
