// Judge saved eval runs against the failure-mode catalog.
//
//   OPENROUTER_API_KEY=… npm run judge -- 2026-07-31T09-12-04-880Z-escalation
//   npm run judge -- --all
//   npm run judge -- --since 2026-07-30 --rejudge
//   npm run judge -- --all --model openai/gpt-5.4
//   npm run judge -- --list
//
// Flags: <runId>… | --all | --since <ISO> | --model <openrouter-slug> | --rejudge | --list
// With no run id and no --all/--since, the newest run is judged.
//
// This reads only what is on disk in data/eval-runs/ — no sandbox, no agent, no
// reset. That is the whole point: a run can be re-judged tomorrow with a different
// model or a rewritten prompt, and the two verdicts are comparable because the
// evidence underneath them is byte-identical.
//
// Models are OpenRouter slugs (dots, not dashes): anthropic/claude-opus-4.8,
// openai/gpt-5.4, … . Set OPENROUTER_MODEL to change the default.

import "./env.js"; // must precede every import that reaches llm.ts
import { TRIAGE_BRIEF } from "../lib/eval/agents.js";
import { projectTrace } from "../lib/eval/judge/project.js";
import { judge } from "../lib/eval/judge/run.js";
import { diffSnapshots } from "../lib/eval/judge/snapshot.js";
import { writeJudge } from "../lib/eval/judge/store.js";
import type { JudgeInput, JudgeReport } from "../lib/eval/judge/types.js";
import { getJudge, getReport, getTrace, listRuns } from "../lib/eval/runs.js";
import { SCENARIOS } from "../lib/eval/scenarios/index.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

/** Flags that eat the next word — otherwise a slug would be read as a run id. */
const VALUE_FLAGS = ["--since", "--model"];
const eaten = new Set<number>();
for (const flag of VALUE_FLAGS) {
  const i = argv.indexOf(flag);
  if (i >= 0 && value(flag) !== undefined) eaten.add(i + 1);
}
const named = argv.filter((a, i) => !a.startsWith("--") && !eaten.has(i));

if (has("--list")) {
  const runs = listRuns();
  if (runs.length === 0) {
    console.log("No runs in data/eval-runs/ yet — run `npm run eval` first.");
    process.exit(0);
  }
  console.log("Saved runs:\n");
  for (const r of runs) {
    const mark = r.hasJudge ? `${GREEN}judged${OFF}  ` : `${DIM}unjudged${OFF}`;
    console.log(`  ${r.runId.padEnd(44)} ${mark} ${DIM}${r.agentName}${OFF}`);
  }
  process.exit(0);
}

const since = value("--since");
if (since !== undefined && Number.isNaN(Date.parse(since))) {
  console.error(`${RED}--since expects an ISO timestamp${OFF}, got "${since}"`);
  process.exit(1);
}

/**
 * Run ids are `<ISO stamp with : and . replaced by ->-<scenario>` (`report.ts`
 * `runIdFor`), so they sort chronologically as plain strings — normalizing the
 * flag the same way makes `--since` a string compare, and a date-only value like
 * `2026-07-30` works as a prefix without any parsing.
 */
const sinceKey = since?.replace(/[:.]/g, "-");

function select(): string[] {
  if (named.length > 0) return named;
  const all = listRuns().map((r) => r.runId); // newest first
  if (sinceKey) return all.filter((id) => id >= sinceKey);
  if (has("--all")) return all;
  // Bare `npm run judge` — the newest run, i.e. the one `npm run eval` just wrote.
  // Announced, because judging is a model call and so costs money.
  const newest = all.slice(0, 1);
  if (newest.length > 0) console.log(`${DIM}no run id given — judging newest: ${newest[0]}${OFF}`);
  return newest;
}

/** Old artifacts have no `snapshots`, and the judge cannot see a mailbox without them. */
const NO_SNAPSHOTS = "run predates snapshot capture — re-run the eval to judge it";

function buildInput(runId: string): JudgeInput {
  const report = getReport(runId);
  if (!report) throw new Error("no report artifact — check the run id with --list");
  const trace = getTrace(runId);
  if (!trace) throw new Error("no .trace.json — nothing to judge without the agent's steps");
  if (!report.snapshots) throw new Error(NO_SNAPSHOTS);

  // Looked up rather than `getScenario`, which throws: a run whose scenario has
  // since been renamed or dropped is still judgeable, just without its difficulty.
  const scenario = SCENARIOS.find((s) => s.id === report.scenarioId);

  return {
    runId,
    task: {
      // The brief is not stored on the artifact because one fixed brief across all
      // runs is the harness's premise (`agents.ts`). Consequence worth knowing:
      // re-judging an old run after the brief changed judges it against the new task.
      brief: TRIAGE_BRIEF,
      scenarioTitle: report.scenarioTitle,
      difficulty: scenario?.difficulty ?? "(scenario is no longer in the catalog)",
    },
    trace: projectTrace(trace),
    env: diffSnapshots(report.snapshots.before, report.snapshots.after),
    assertions: report.verdict.assertions,
  };
}

const SEVERITY_COLOR: Record<string, string> = { critical: RED, major: YELLOW, minor: DIM };

function printJudge(report: JudgeReport): void {
  console.log(`\n${BOLD}${report.runId}${OFF} ${DIM}judged by ${report.model}${OFF}`);
  console.log(`\n${DIM}task, as the judge read it:${OFF} ${report.taskUnderstanding}`);
  console.log(
    `${DIM}actions make sense:${OFF} ` +
      (report.actionsMakeSense ? `${GREEN}yes${OFF}` : `${RED}no${OFF}`),
  );
  console.log(`${DIM}summary:${OFF} ${report.summary}`);

  // Uncatalogued findings print alongside the catalog ones — they are the signal
  // that the taxonomy needs an entry, so burying them defeats the escape hatch.
  const findings = [
    ...report.findings.map((f) => ({ severity: f.severity, label: f.mode, evidence: f.evidence })),
    ...report.otherFindings.map((f) => ({
      severity: f.severity,
      label: `${f.label} ${DIM}(uncatalogued)${OFF}`,
      evidence: f.evidence,
    })),
  ];

  if (findings.length === 0) {
    console.log(`\n${GREEN}No failure modes found.${OFF}`);
    return;
  }

  console.log(`\n${BOLD}Findings${OFF}`);
  for (const f of findings) {
    const color = SEVERITY_COLOR[f.severity] ?? DIM;
    // First piece of evidence only: the rest is in the artifact, and a console line
    // is a pointer to a finding, not the finding itself.
    const evidence = f.evidence[0] ?? "(no evidence cited)";
    console.log(`  ${color}${f.severity.padEnd(8)}${OFF} ${f.label} ${DIM}—${OFF} ${evidence}`);
  }
}

const runIds = select();
const model = value("--model");
const rejudge = has("--rejudge");

let judgedCount = 0;
let skipped = 0;
let failures = 0;

for (const runId of runIds) {
  // Judging is idempotent but not free, so a run keeps its verdict unless asked.
  if (!rejudge && getJudge(runId)) {
    console.log(`${DIM}skipping ${runId} — already judged (use --rejudge)${OFF}`);
    skipped++;
    continue;
  }

  try {
    const report = await judge(buildInput(runId), { model });
    const file = writeJudge(report);
    printJudge(report);
    console.log(`${DIM}  judge: ${file}${OFF}`);
    judgedCount++;
  } catch (err) {
    // One unjudgeable run must not take the batch down with it — an artifact from
    // before snapshot capture sits in the same directory as today's.
    console.error(`\n${RED}Run "${runId}" could not be judged:${OFF} ${(err as Error).message}`);
    failures++;
  }
}

if (runIds.length === 0) {
  console.log("No runs matched. List what is on disk with --list.");
} else if (runIds.length > 1) {
  console.log(`\n  ${judgedCount} judged, ${skipped} skipped, ${failures} failed\n`);
}

// Non-zero exit only when a run could not be judged. Findings are the product, not
// a failure — gating on them would make a working judge look like a broken build.
process.exit(failures > 0 ? 1 : 0);
