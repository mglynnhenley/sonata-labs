// Run a triage stress-test against the sandbox.
//
//   PORT=3100 ANTHROPIC_API_KEY=… npm run eval -- --scenario escalation
//   PORT=3100 npm run eval -- --all
//   PORT=3100 npm run eval -- --scenario escalation --agent naive   # known-bad control
//
// Flags: --scenario <id> | --all | --agent reference|naive | --no-reset | --no-judge | --list

import { runEval } from "../lib/eval/runEval.js";
import { naiveArchiveAgent, referenceClaudeTriageAgent } from "../lib/eval/agents.js";
import { SCENARIOS, scenarioIds } from "../lib/eval/scenarios/index.js";
import { printReport, printSummary, writeReport } from "../lib/eval/report.js";
import type { EvalReport, TriageAgent } from "../lib/eval/types.js";

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

if (has("--list")) {
  console.log("Available scenarios:\n");
  for (const s of SCENARIOS) {
    console.log(`  ${s.id.padEnd(20)} [${s.family}]  ${s.title}`);
  }
  process.exit(0);
}

const agentName = value("--agent") ?? "reference";
const agent: TriageAgent =
  agentName === "naive"
    ? naiveArchiveAgent
    : referenceClaudeTriageAgent({ model: value("--model") });

const ids = has("--all") ? scenarioIds() : [value("--scenario") ?? "escalation"];
const resetAfter = !has("--no-reset");
const useJudge = !has("--no-judge");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const reports: EvalReport[] = [];
let failures = 0;

for (const id of ids) {
  try {
    const report = await runEval({
      scenario: id,
      agent,
      resetAfter,
      useJudge,
      onProgress: (step) => console.log(`  \x1b[2m→ ${step}\x1b[0m`),
    });
    printReport(report);
    const file = writeReport(report, stamp);
    console.log(`\x1b[2m  report: ${file}\x1b[0m`);
    reports.push(report);
    if (report.verdict.outcome === "fail") failures++;
  } catch (err) {
    console.error(`\n\x1b[31mScenario "${id}" errored:\x1b[0m ${(err as Error).message}`);
    failures++;
  }
}

printSummary(reports);

// Non-zero exit when a run failed, so this is usable as a gate. Note: with
// --agent naive, failures are the EXPECTED result (it's the control).
process.exit(failures > 0 ? 1 : 0);
