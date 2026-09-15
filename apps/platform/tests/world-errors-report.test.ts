import { describe, expect, it } from "vitest";
import type { EpisodeRun } from "@sonata/core";
import { harnessReport, hasFaults, harnessMarkdown } from "../app/results/_components/harness";

function run(): EpisodeRun {
  return {
    runId: "world-fault", specId: "fixture", specTitle: "Fixture", model: "test/model",
    status: "done", startedAt: 1, endedAt: 2, snapshots: {}, verdict: null,
    ticks: [{ tick: 13, simTimeISO: "2026-09-14T12:15:00Z", startedAt: 1, endedAt: 2,
      beatsFired: [], agentSteps: [],
      directorEvents: [{ id: "dir-13-0", personId: "reviewer", reason: "reply",
        twin: "slack", kind: "message", payload: { channel: "missing", from: "reviewer", text: "Review" },
        error: "channel 'missing' not found" }],
      notes: ["event dir-13-0: channel 'missing' not found"],
    }],
  };
}
function report(input: EpisodeRun) {
  return harnessReport({ run: input, spec: null, capture: { complete: true, summary: "Captured" }, offsetMinutes: 0 }).report;
}

describe("simulation failures in the report", () => {
  it("shows a failed colleague injection once, even when the day completed and capture is whole", () => {
    const result = report(run());
    expect(result.worldErrors).toEqual([{ tick: 13, clock: "12:15", message: "dir-13-0: channel 'missing' not found" }]);
    expect(hasFaults(result)).toBe(true);
    expect(harnessMarkdown(result)).toContain("Some simulated colleague responses failed");
    expect(harnessMarkdown(result)).toContain("channel 'missing' not found");
  });
  it("retains a director model failure that produced no event", () => {
    const input = run();
    input.ticks[0].directorEvents = [];
    input.ticks[0].notes = ["director call failed for reviewer: provider unavailable"];
    expect(report(input).worldErrors).toHaveLength(1);
  });
  it("does not reclassify an agent tool error or an ordinary world note", () => {
    const input = run();
    input.ticks[0].directorEvents = [];
    input.ticks[0].notes = ["director called nobody: nobody had a reason to speak", "agent tool failed: invalid argument"];
    expect(report(input).worldErrors).toEqual([]);
  });
});
