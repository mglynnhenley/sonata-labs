import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { JUDGE_SUFFIX, readJudge } from "./judge/store";
import type { JudgeReport } from "./judge/types";
import { runsDir } from "./report";
import type { RunTrace } from "./trace";
import type { EvalReport, StressScenario, Verdict } from "./types";

// Read side of the run artifacts the CLI writes. The API routes are thin wrappers
// over this; keeping the filesystem knowledge here means the traversal guard
// lives in exactly one place.

const TRACE_SUFFIX = ".trace.json";

/** A run id is a filename base, and it arrives from a URL — never trust it. */
const SAFE_RUN_ID = /^[\w.-]+$/;

function resolveArtifact(runId: string, suffix: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const dir = runsDir();
  const file = path.resolve(dir, `${runId}${suffix}`);
  // Belt and braces: even a run id that passes the pattern must land inside the
  // runs directory.
  return file.startsWith(dir + path.sep) ? file : null;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** What the run list shows — cheap fields only, no transcript. */
export interface RunSummary {
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  agentName: string;
  outcome: Verdict["outcome"];
  score: number;
  durationMs: number;
  hasTrace: boolean;
  hasJudge: boolean;
}

export function listRuns(): RunSummary[] {
  let names: string[];
  try {
    names = readdirSync(runsDir());
  } catch {
    return []; // no runs yet
  }

  const traces = new Set(
    names.filter((n) => n.endsWith(TRACE_SUFFIX)).map((n) => n.slice(0, -TRACE_SUFFIX.length)),
  );
  const judged = new Set(
    names.filter((n) => n.endsWith(JUDGE_SUFFIX)).map((n) => n.slice(0, -JUDGE_SUFFIX.length)),
  );

  return names
    // Every sibling artifact ends `.json` too, and what survives this filter is
    // blind-cast to `EvalReport` below — so each new suffix must be excluded here
    // or a judged run shows up in the list a second time as a garbage row.
    .filter((n) => n.endsWith(".json") && !n.endsWith(TRACE_SUFFIX) && !n.endsWith(JUDGE_SUFFIX))
    .map((n) => n.slice(0, -".json".length))
    .flatMap((runId) => {
      const report = getReport(runId);
      if (!report) return []; // unreadable or half-written artifact
      return [
        {
          runId,
          scenarioId: report.scenarioId,
          scenarioTitle: report.scenarioTitle,
          agentName: report.agentName,
          outcome: report.verdict.outcome,
          score: report.verdict.score,
          durationMs: report.durationMs,
          hasTrace: traces.has(runId),
          hasJudge: judged.has(runId),
        },
      ];
    })
    .sort((a, b) => b.runId.localeCompare(a.runId)); // newest first — ids are timestamps
}

export function getReport(runId: string): EvalReport | null {
  const file = resolveArtifact(runId, ".json");
  return file ? readJson<EvalReport>(file) : null;
}

export function getTrace(runId: string): RunTrace | null {
  const file = resolveArtifact(runId, TRACE_SUFFIX);
  return file ? readJson<RunTrace>(file) : null;
}

/**
 * The judge artifact, if this run has been judged. Delegated rather than read here
 * because the judge owns its own suffix and traversal guard (`judge/store.ts`);
 * this is the one door the API routes and the CLI already come through.
 */
export function getJudge(runId: string): JudgeReport | null {
  return readJudge(runId);
}

/**
 * Scenarios minus their assertion closures. `StressScenario.assertions[].check`
 * is a function, so the catalog cannot be sent to the browser as-is.
 */
export interface ScenarioView {
  id: string;
  title: string;
  family: string;
  difficulty: string;
  judgeQuestion: string;
  assertions: Array<{ id: string; description: string; severity: string }>;
}

export function toScenarioView(s: StressScenario): ScenarioView {
  return {
    id: s.id,
    title: s.title,
    family: s.family,
    difficulty: s.difficulty,
    judgeQuestion: s.judgeQuestion,
    assertions: s.assertions.map((a) => ({
      id: a.id,
      description: a.description,
      severity: a.severity,
    })),
  };
}
