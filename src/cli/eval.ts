// Run a triage stress-test against the sandbox.
//
//   PORT=3100 OPENROUTER_API_KEY=… npm run eval -- --scenario escalation
//   PORT=3100 npm run eval -- --all
//   PORT=3100 npm run eval -- --scenario escalation --agent naive   # known-bad control
//   PORT=3100 npm run eval -- --scenario bump --model openai/gpt-5.4
//
// Cheap first pass — cheap agent and generation, capable judge:
//   PORT=3100 npm run eval -- --all --model anthropic/claude-haiku-4.5 \
//     --gen-model anthropic/claude-haiku-4.5 --judge-model anthropic/claude-opus-4.8
//
// Flags: --scenario <id> | --all | --agent reference|naive | --model <openrouter-slug>
//        | --gen-model <slug> (profiler + generator + pipeline) | --judge-model <slug>
//        | --effort low|medium|high|none (caps reasoning effort — the speed lever)
//        | --no-reset | --no-judge | --list
//
// Models are OpenRouter slugs (dots, not dashes): anthropic/claude-opus-4.8,
// openai/gpt-5.4, … . Set OPENROUTER_MODEL to change the default for every role.
// List available slugs:
//   curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'

import "./env.js"; // must precede every import that reaches llm.ts
import { runEval } from "../lib/eval/runEval.js";
import { naiveArchiveAgent, referenceTriageAgent } from "../lib/eval/agents.js";
import { SCENARIOS, scenarioIds } from "../lib/eval/scenarios/index.js";
import {
  printReport,
  printSummary,
  runIdFor,
  writeReport,
  writeTrace,
} from "../lib/eval/report.js";
import { writeJudge } from "../lib/eval/judge/store.js";
import { newTrace } from "../lib/eval/trace.js";
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
    : referenceTriageAgent({ model: value("--model") });

// Per-role models. A cheap pass usually wants a cheap agent and cheap scenario
// generation but a capable judge — grading is the thing being trusted, so making it
// cheap undermines the run it is meant to assess. `--gen-model` covers the profiler,
// the generator and the pipeline stages; `--judge-model` is deliberately separate.
// Reasoning effort is most of the wall clock: compose and the judge both ask for
// "high". `--effort low` (or `none`) caps every stage at once — the lever for a fast
// smoke pass. Read per request in llm.ts, so setting it here is enough.
const effortCap = value("--effort");
if (effortCap) process.env.EVAL_MAX_EFFORT = effortCap;

const genModel = value("--gen-model");
const models = {
  agent: value("--model"),
  judge: value("--judge-model"),
  profiler: genModel,
  generator: genModel,
  rank: genModel,
  comprehend: genModel,
  options: genModel,
  compose: genModel,
};

const ids = has("--all") ? scenarioIds() : [value("--scenario") ?? "escalation"];
// Each scenario resets on the way IN, and leaves its mailbox standing on the way
// out — so when a batch finishes you can open the UI and see what the last agent
// actually did. `--no-reset` opts out of resetting at all (state accumulates).
const resetBefore = !has("--no-reset");
const useJudge = !has("--no-judge");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const reports: EvalReport[] = [];
let failures = 0;

// Derived once and reused: every scenario resets to the same pristine snapshot, so
// re-profiling per scenario buys nothing and costs a model call each time.
let profile: EvalReport["profile"];

for (const id of ids) {
  try {
    const trace = newTrace(runIdFor(stamp, id));
    const report = await runEval({
      scenario: id,
      agent,
      models,
      profile,
      resetBefore,
      useJudge,
      // --no-judge means no model grading at all, rubric or diagnosis — otherwise the
      // flag still pays for a high-effort failure-mode call on every scenario.
      judgeFailureModes: useJudge,
      trace,
      onProgress: (step) => console.log(`  \x1b[2m→ ${step}\x1b[0m`),
    });
    profile ??= report.profile; // first scenario pays for it; the rest ride along
    printReport(report);
    const file = writeReport(report, stamp);
    const traceFile = writeTrace(trace);
    console.log(`\x1b[2m  report: ${file}\x1b[0m`);
    console.log(`\x1b[2m  trace:  ${traceFile}\x1b[0m`);
    // The diagnosis is inside the report too, but only `<runId>.judge.json` is what
    // the viewer, `listRuns().hasJudge` and `npm run judge` look for.
    if (report.judgeReport) {
      console.log(`\x1b[2m  judge:  ${writeJudge(report.judgeReport)}\x1b[0m`);
    }
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
