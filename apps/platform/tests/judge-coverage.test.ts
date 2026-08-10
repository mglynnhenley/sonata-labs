import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EpisodeJudgeReport, EpisodeRun, JudgeCoverage, TickRecord } from "@sonata/core";

// HOW MUCH OF THE DAY THE JUDGE READ, AND WHO IS ALLOWED TO SAY "WE DO NOT KNOW".
//
// `judgeSight` has three answers, and the results page prints a different
// sentence for each: nothing (the judge read the whole day), "formed on two
// thirds of this day" (a known sample), and "how much of this day the assessor
// read was not recorded — re-judge the run to find out". Only the third is
// dangerous, because it is the one the reader cannot check.
//
// It was printing on EVERY judged run. `normalizeJudge` rebuilds the report
// field by field out of the file, and it had no line for `coverage` — so a
// report whose own record said `complete: true` came back through `readRun` with
// no record at all, and the page told the reader to spend a model call resolving
// a doubt the next read would have re-created. The reads are what these pin: a
// report that counted must come back counted, a report that did not must not be
// dressed up as one, and a half-written count is not a count.
//
// Offline and in a temp runs dir — `readRun` resolves artifacts against
// SONATA_RUNS_DIR, so it is set before the dynamic imports under it.

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-coverage-"));
const RUNS = path.join(sandbox, "runs");
process.env.SONATA_RUNS_DIR = RUNS;
process.chdir(sandbox);
mkdirSync(RUNS, { recursive: true });

const { readRun } = await import("../app/results/_lib/artifacts");
const { judgeSight } = await import("../app/results/_components/harness");

// ---------------------------------------------------------------------------

const whole: JudgeCoverage = {
  steps: { shown: 28, total: 28 },
  timeline: { shown: 13, total: 13 },
  narration: { shown: 28, total: 28 },
  finalState: { shown: 7, total: 7 },
  fraction: 1,
  complete: true,
};

function report(coverage?: unknown): Record<string, unknown> {
  return {
    runId: "r",
    judgedAt: 1_700_000_000_000,
    model: "anthropic/claude-haiku-4.5",
    ...(coverage === undefined ? {} : { coverage }),
    taskUnderstanding: "Handle the morning.",
    autonomyScore: 0.55,
    summary: "It answered the client and stopped.",
    findings: [],
    otherFindings: [],
    answers: [],
  };
}

let n = 0;

/**
 * A tick with one real mutation in it. Required, not decoration: `readRun` drops
 * the verdict of a run that never executed, so a day with no work in it would
 * carry no judge report and every assertion below would pass vacuously.
 */
function tick(i: number): TickRecord {
  return {
    tick: i,
    simTimeISO: `2026-08-06T${String(9 + i).padStart(2, "0")}:00:00.000Z`,
    startedAt: 1_700_000_000_000 + i,
    endedAt: 1_700_000_000_500 + i,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [
      {
        kind: "tool",
        seq: i + 1,
        at: 1_700_000_000_100 + i,
        twin: "gmail",
        name: "gmail.send",
        args: {},
        resultSummary: "sent",
        isMutation: true,
      },
    ],
    notes: [],
  };
}

/** File a finished, judged run and read it back the way the page does. */
function fileAndRead(coverage?: unknown): EpisodeJudgeReport | null {
  const runId = `run_cov_${++n}`;
  const run: EpisodeRun = {
    runId,
    specId: "ep-cov",
    specTitle: "A judged day",
    model: "anthropic/claude-haiku-4.5",
    status: "done",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    ticks: [tick(0), tick(1)],
    snapshots: {},
    verdict: {
      outcome: "partial",
      score: 0.5,
      autonomy: 0.62,
      checklist: [],
      judge: report(coverage) as unknown as EpisodeJudgeReport,
      cost: { usd: 0.12, promptTokens: 10, completionTokens: 2, llmCalls: 3 },
    },
  };
  writeFileSync(path.join(RUNS, `${runId}.json`), `${JSON.stringify(run)}\n`, "utf8");
  return readRun(runId)?.verdict?.judge ?? null;
}

// ---------------------------------------------------------------------------

describe("a judge report that counted what it read", () => {
  it("still carries its coverage after a round trip through the artifact", () => {
    expect(fileAndRead(whole)?.coverage).toEqual(whole);
  });

  it("is not told it was unrecorded — that note cost a re-judge that could not fix it", () => {
    // Null is the one silent answer: the judge read the whole day, so there is
    // nothing to warn the reader about before they read the findings.
    expect(judgeSight(fileAndRead(whole))).toBeNull();
  });

  it("keeps a real sample a real sample", () => {
    const sampled: JudgeCoverage = {
      steps: { shown: 200, total: 304 },
      timeline: { shown: 40, total: 40 },
      narration: { shown: 90, total: 90 },
      fraction: 200 / 304,
      complete: false,
    };
    const sight = judgeSight(fileAndRead(sampled));
    expect(sight?.kind).toBe("partial");
    // The worst list first, said the way the page says it.
    expect(sight).toMatchObject({
      missing: [{ what: "things the agent did", shown: 200, total: 304 }],
    });
  });
});

describe("a judge report from before the counting", () => {
  it("comes back with no coverage, and is said to be unrecorded", () => {
    expect(fileAndRead()?.coverage).toBeUndefined();
    expect(judgeSight(fileAndRead())).toEqual({ kind: "unrecorded" });
  });

  it("treats a half-written count as no count rather than as a whole day", () => {
    // `narration` missing. Reporting `complete` off the two slices that survived
    // would vouch for a day nobody measured — the failure this file exists for,
    // pointing the other way.
    const sight = judgeSight(
      fileAndRead({
        steps: { shown: 5, total: 5 },
        timeline: { shown: 5, total: 5 },
        fraction: 1,
        complete: true,
      }),
    );
    expect(sight).toEqual({ kind: "unrecorded" });
  });

  it("derives `complete` when the file records a fraction and no flag", () => {
    const judged = fileAndRead({
      steps: { shown: 9, total: 9 },
      timeline: { shown: 4, total: 4 },
      narration: { shown: 9, total: 9 },
      fraction: 1,
    });
    expect(judged?.coverage?.complete).toBe(true);
    expect(judgeSight(judged)).toBeNull();
  });
});
