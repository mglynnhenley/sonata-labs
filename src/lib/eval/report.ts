import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EvalReport } from "./types";

// Console summary + JSON artifact. data/eval-runs/ is gitignored.

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function outcomeColor(outcome: string): string {
  if (outcome === "pass") return GREEN;
  if (outcome === "partial") return YELLOW;
  return RED;
}

export function printReport(report: EvalReport): void {
  const { verdict, outcome } = report;

  console.log(`\n${BOLD}${report.scenarioTitle}${OFF}`);
  console.log(`${DIM}scenario:${OFF} ${report.scenarioId}  ${DIM}family:${OFF} ${report.family}`);
  console.log(`${DIM}agent:${OFF} ${report.agentName}`);
  console.log(
    `${DIM}fixture:${OFF} ${report.fixture.messages.length} message(s)` +
      (report.anchoredToRealThread ? ", threaded onto a real conversation" : ", self-contained"),
  );

  const probe = report.fixture.messages.find(
    (m) => m.slotId === report.fixture.probeSlotId,
  );
  if (probe) {
    console.log(`\n${DIM}probe:${OFF} "${probe.subject}" from ${probe.from}`);
  }

  console.log(`\n${BOLD}Assertions${OFF}`);
  for (const a of verdict.assertions) {
    const mark = a.passed ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
    const tag = a.severity === "must" ? `${DIM}[must]${OFF}  ` : `${DIM}[should]${OFF}`;
    console.log(`  ${mark} ${tag} ${a.description}`);
  }

  console.log(`\n${BOLD}What the agent did${OFF}`);
  if (outcome.allActions.length === 0) {
    console.log(`  ${DIM}(no actions)${OFF}`);
  } else {
    for (const a of outcome.allActions.slice().reverse()) {
      console.log(`  ${DIM}·${OFF} ${a.summary}`);
    }
  }

  if (verdict.judge) {
    console.log(`\n${BOLD}Judge${OFF} ${verdict.judge.handledWell ? `${GREEN}handled well${OFF}` : `${RED}mishandled${OFF}`}`);
    console.log(`  ${verdict.judge.reasoning}`);
    for (const e of verdict.judge.evidence) console.log(`  ${DIM}·${OFF} ${e}`);
  }

  const c = outcomeColor(verdict.outcome);
  console.log(
    `\n${BOLD}Verdict:${OFF} ${c}${verdict.outcome.toUpperCase()}${OFF}` +
      `  ${DIM}(should-score ${(verdict.score * 100).toFixed(0)}%, ${(report.durationMs / 1000).toFixed(1)}s)${OFF}\n`,
  );
}

export function printSummary(reports: EvalReport[]): void {
  if (reports.length < 2) return;
  console.log(`${BOLD}Summary${OFF}`);
  for (const r of reports) {
    const c = outcomeColor(r.verdict.outcome);
    console.log(
      `  ${c}${r.verdict.outcome.toUpperCase().padEnd(7)}${OFF} ${r.scenarioId.padEnd(20)} ${DIM}${r.agentName}${OFF}`,
    );
  }
  const pass = reports.filter((r) => r.verdict.outcome === "pass").length;
  console.log(`\n  ${pass}/${reports.length} passed\n`);
}

/** Write the JSON artifact. `stamp` is supplied by the caller (keeps this pure). */
export function writeReport(report: EvalReport, stamp: string): string {
  const dir = path.resolve(process.cwd(), "data", "eval-runs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${report.scenarioId}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}
