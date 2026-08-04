import type { EpisodeJudgeReport } from "@sonata/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_SUFFIX, judgePath, listJudged, readJudgeReport, writeJudgeReport } from "../src/store";

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), "sonata-judge-"));
}

function report(runId: string): EpisodeJudgeReport {
  return {
    runId,
    judgedAt: 1,
    model: "anthropic/claude-haiku-4.5",
    taskUnderstanding: "Answer Dana.",
    autonomyScore: 0.5,
    summary: "Half a day's work.",
    findings: [],
    otherFindings: [],
    answers: [],
  };
}

describe("store", () => {
  it("round-trips a report beside the run", () => {
    const d = dir();
    const file = writeJudgeReport(d, report("2026-08-04T09-00-00"));
    expect(file.endsWith(JUDGE_SUFFIX)).toBe(true);
    expect(readJudgeReport(d, "2026-08-04T09-00-00")).toEqual(report("2026-08-04T09-00-00"));
  });

  it("overwrites — re-judging the same run is the point", () => {
    const d = dir();
    writeJudgeReport(d, report("r1"));
    writeJudgeReport(d, { ...report("r1"), summary: "second opinion" });
    expect(readJudgeReport(d, "r1")?.summary).toBe("second opinion");
  });

  it("creates the directory rather than failing on a first run", () => {
    const d = path.join(dir(), "nested", "runs");
    writeJudgeReport(d, report("r1"));
    expect(readJudgeReport(d, "r1")).not.toBeNull();
  });

  it("refuses a run id that would escape the runs directory", () => {
    expect(judgePath("/tmp/runs", "../../etc/passwd")).toBeNull();
    expect(readJudgeReport("/tmp/runs", "../../etc/passwd")).toBeNull();
    expect(() => writeJudgeReport("/tmp/runs", report("../evil"))).toThrow(/unsafe run id/);
  });

  it("returns null for an absent or half-written artifact rather than throwing", () => {
    const d = dir();
    expect(readJudgeReport(d, "never-ran")).toBeNull();
    writeFileSync(path.join(d, `torn${JUDGE_SUFFIX}`), "{ half");
    expect(readJudgeReport(d, "torn")).toBeNull();
  });

  it("lists judged runs newest first and ignores everything else", () => {
    const d = dir();
    writeJudgeReport(d, report("2026-08-04T09-00-00"));
    writeJudgeReport(d, report("2026-08-05T09-00-00"));
    writeFileSync(path.join(d, "2026-08-06T09-00-00.json"), "{}"); // the run itself
    expect(listJudged(d)).toEqual(["2026-08-05T09-00-00", "2026-08-04T09-00-00"]);
  });

  it("returns nothing for a directory that does not exist yet", () => {
    expect(listJudged(path.join(dir(), "absent"))).toEqual([]);
  });
});
