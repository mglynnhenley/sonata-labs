import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EpisodeRun } from "@sonata/core";

const transport = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../src/lib/engine/inspectJudge", () => ({ inspectCompletion: () => async () => {
  transport.calls++;
  if (transport.fail) throw new Error("Provider refused the assessment");
  return { taskUnderstanding: "Reply to the client", autonomyScore: 0.5,
    summary: `Assessment ${transport.calls}`, findings: [], otherFindings: [], answers: [] };
} }));
const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-assessments-"));
process.env.SONATA_RUNS_DIR = sandbox;
process.chdir(sandbox);
const { judgeRun } = await import("../src/lib/engine/verdict");
const { listAssessments, assessmentDir } = await import("../src/lib/engine/assessments");
const { readRun } = await import("../app/results/_lib/artifacts");

function fixture(id: string): EpisodeRun {
  const raw = { runId: id, specId: "fixture", status: "done", model: "agent/model", snapshots: {}, audit: [],
    ticks: [{ tick: 0, simTimeISO: "2026-09-14T09:00:00Z", beatsFired: [], directorEvents: [], notes: [],
      agentSteps: [{ kind: "tool", seq: 1, twin: "gmail", name: "send_message", at: 1, args: {}, isMutation: true, resultSummary: "Sent" }] }],
    verdict: { checklist: [], score: 0, autonomy: 0, cost: { usd: 0.1, llmCalls: 1, promptTokens: 0, completionTokens: 0 },
      judge: { runId: id, model: "legacy/judge", judgedAt: 1, autonomyScore: 0.3, summary: "Old report", findings: [], otherFindings: [], answers: [] } },
  };
  writeFileSync(path.join(sandbox, `${id}.json`), JSON.stringify(raw));
  return raw as unknown as EpisodeRun;
}

describe("assessment history", () => {
  it("keeps the old report and both new judges without changing the recorded work", async () => {
    const run = fixture("history");
    const first = await judgeRun(run, null, { model: "judge/one", manual: true });
    const firstBytes = readFileSync(path.join(assessmentDir(run.runId, first.assessment.id), "assessment.json"), "utf8");
    await judgeRun(readRun(run.runId)!, null, { model: "judge/two", manual: true });
    const history = listAssessments(run.runId);
    expect(history).toHaveLength(3);
    expect(new Set(history.map(a => a.model))).toEqual(new Set(["legacy/judge", "judge/one", "judge/two"]));
    expect(readFileSync(path.join(assessmentDir(run.runId, first.assessment.id), "assessment.json"), "utf8")).toBe(firstBytes);
    const latest = JSON.parse(readFileSync(path.join(sandbox, `${run.runId}.json`), "utf8"));
    expect(latest.ticks).toEqual(run.ticks);
    expect(latest.snapshots).toEqual(run.snapshots);
    expect(latest.verdict.judge.model).toBe("judge/two");
  });

  it("keeps a failed attempt without replacing the last successful report", async () => {
    const run = fixture("failure");
    transport.fail = true;
    await expect(judgeRun(run, null, { model: "judge/broken" })).rejects.toThrow("Provider refused");
    transport.fail = false;
    expect(listAssessments(run.runId).map(a => a.status)).toEqual(["failed", "judged"]);
    expect(readRun(run.runId)?.verdict?.judge?.model).toBe("legacy/judge");
    await judgeRun(readRun(run.runId)!, null, { model: "judge/recovery" });
    expect(listAssessments(run.runId)).toHaveLength(3);
  });

  it("rejects paths outside the run's assessment directory", () => {
    expect(() => assessmentDir("../run", "id")).toThrow("Invalid");
    expect(() => assessmentDir("run", "..")).toThrow("Invalid");
  });
});
