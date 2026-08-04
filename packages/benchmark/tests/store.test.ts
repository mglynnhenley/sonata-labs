import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_SUFFIX,
  listRunIds,
  readReport,
  readRunArtifact,
  reportPath,
  runPath,
  writeReport,
  writeRunArtifact,
} from "../src/store";
import { aggregate } from "../src/aggregate";
import { episodeRun, MATRIX } from "./fixtures";

// Artifacts are the only durable thing a benchmark produces, and resume reads
// them back by filename. So the filename rules are tested, not assumed.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sonata-bench-"));
});

describe("paths", () => {
  it("refuses ids that are not a safe filename base", () => {
    expect(runPath(dir, "../escape")).toBeNull();
    expect(runPath(dir, "with/slash")).toBeNull();
    expect(reportPath(dir, "../../etc/passwd")).toBeNull();
    expect(runPath(dir, "bench1--scenario--model--s0")).toBe(
      path.join(dir, "bench1--scenario--model--s0.json"),
    );
  });

  it("keeps a dotted id inside the directory rather than walking out of it", () => {
    // ".." is allowed by the character rule, and stays harmless: the suffix makes
    // it the ordinary filename "...json" rather than a parent-directory hop.
    expect(runPath(dir, "..")).toBe(path.join(dir, "...json"));
  });

  it("throws rather than silently dropping a write, which would lose an hour's spend", () => {
    expect(() => writeRunArtifact(dir, episodeRun({ runId: "a/b" }))).toThrow(/unsafe id/);
  });
});

describe("round trip", () => {
  it("writes and reads back a run artifact unchanged", () => {
    const run = episodeRun({ runId: "bench1--sla--haiku--s1", modes: ["stalled"] });
    writeRunArtifact(dir, run);
    expect(readRunArtifact(dir, run.runId)).toEqual(run);
  });

  it("treats an absent or half-written artifact as not run", () => {
    expect(readRunArtifact(dir, "never-written")).toBeNull();
    writeFileSync(path.join(dir, "truncated.json"), '{"runId": "trunc');
    expect(readRunArtifact(dir, "truncated")).toBeNull();
  });

  it("writes and reads back a report", () => {
    const report = {
      matrix: MATRIX,
      startedAt: 1,
      endedAt: 2,
      results: [],
      aggregate: aggregate(MATRIX, []),
    };
    writeReport(dir, report);
    expect(readReport(dir, MATRIX.id)).toEqual(report);
  });
});

describe("listRunIds", () => {
  it("returns nothing when the directory does not exist yet", () => {
    expect(listRunIds(path.join(dir, "nope"))).toEqual([]);
  });

  it("excludes the judge and benchmark siblings, which also end .json", () => {
    writeRunArtifact(dir, episodeRun({ runId: "cell-a" }));
    writeRunArtifact(dir, episodeRun({ runId: "cell-b" }));
    writeFileSync(path.join(dir, "cell-a.judge.json"), "{}");
    writeFileSync(path.join(dir, `bench1${BENCHMARK_SUFFIX}`), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "hi");

    // A naive "*.json" scan would invent the run ids "cell-a.judge" and
    // "bench1.benchmark" and then plan around cells that do not exist.
    expect(listRunIds(dir)).toEqual(["cell-a", "cell-b"]);
  });
});
