import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { harnessDefectEvidence, type CriterionResult, type EpisodeRun, type EpisodeSpec, type TickRecord } from "@sonata/core";
import { describeEvidence, type RunBrief, type SavedRun } from "../app/results/_lib/artifacts";
import { buildRunReport } from "../app/results/_lib/report";
import { assembleRunDocument, loadRunDocument } from "../app/results/_lib/document";
import { criterionFault, faultPhrase, judgeSight } from "../app/results/_components/harness";
import { GET as download } from "../app/api/results/[runId]/report/route";

const brief: RunBrief = {
  task: "Assist Marta with investor cases. Draft requests for review and hold unresolved cases.",
  judgeQuestions: [], offsetMinutes: 0, people: {},
};
const criterion = (over: Partial<CriterionResult> = {}): CriterionResult => ({
  id: "c-hold", description: "Keep 00107 pending Daniel review; draft its request by tick 4.",
  twin: "excel", kind: "judged", severity: "must", weight: 1, status: "passed",
  evidence: "00107 is on Hold with Daniel owner and tomorrow noon due date; request draft saved (step 3).",
  ...over,
});
function tick(n: number): TickRecord {
  return {
    tick: n, simTimeISO: `2026-09-17T${String(9 + n).padStart(2, "0")}:00:00Z`,
    startedAt: 1000 + n, endedAt: 1010 + n, beatsFired: [], directorEvents: [], notes: [],
    agentSteps: [{ kind: "tool", seq: n + 1, at: 1001 + n, twin: "gmail", name: "create_draft", args: {}, resultSummary: "draft saved", isMutation: true }],
  };
}
function run(over: Partial<EpisodeRun> = {}): SavedRun {
  const value: EpisodeRun = {
    runId: "run_report_fixture", specId: "accountancy", specTitle: "Accountancy day", model: "fixture/model",
    status: "done", startedAt: 1000, endedAt: 61000, ticks: [tick(0), tick(1)], snapshots: {
      gmail: {
        before: { twin: "gmail", capturedAt: 1, labels: [], threads: [], drafts: [] },
        after: { twin: "gmail", capturedAt: 2, labels: [], threads: [], drafts: [] },
      },
    },
    verdict: { outcome: "pass", score: 1, autonomy: 0.7, checklist: [criterion()], judge: null,
      cost: { usd: 0.1, llmCalls: 2, promptTokens: 10, completionTokens: 10 } },
    ...over,
  };
  return { ...value, simulated: false, evidence: describeEvidence({ twins: ["gmail", "excel"], snapshots: value.snapshots, audit: value.audit ?? [] }) };
}
function spec(): EpisodeSpec {
  return {
    id: "accountancy", title: "Original accountancy day", task: brief.task!, story: "Saved scenario version",
    clock: { startISO: "2026-09-17T09:00:00Z", ticks: 8, simMinutesPerTick: 60 },
    world: { business: { name: "North Quay", description: "Tax advisers", industry: "Accounting", size: 8 }, cast: [], channels: [], mailboxOwner: "ai" },
    beats: [], director: { maxEventsPerTick: 1, personas: [], offLimits: [], style: "concise" },
    success: { checklist: [], judgeQuestions: [] },
    termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 0 },
  };
}

describe("a portable report's evidence boundaries", () => {
  it("reports a correct pending case as a passed requirement and preserves deadline and evidence anchors", () => {
    const markdown = buildRunReport(run(), brief);
    expect(markdown).toContain("passed its checked requirements");
    expect(markdown).toContain("by tick 4");
    expect(markdown).toContain("(step 3)");
    expect(markdown).toContain("Prepared an email draft");
    expect(markdown).not.toContain("Where a human would have had to step in");
    expect(markdown).not.toContain("Nothing it did would have needed correcting");
  });

  it("names the clock the day ran on, and says a run on the experimental one is not comparable", () => {
    const candidate = buildRunReport(run({ timing: { policy: "provider-operations-v1", workUnitsPerTick: 24 } }), brief);
    expect(candidate).toContain("24 work units per interval");
    expect(candidate).toContain("cannot be compared with a run on the default compressed clock");
    expect(candidate).not.toContain("default compressed clock, so model latency");

    const baseline = buildRunReport(run({ timing: { policy: "compressed-wall-time" } }), brief);
    expect(baseline).toContain("model latency, retries and host contention consumed simulated business time");
    expect(baseline).not.toContain("provider-operations-v1");

    // A run from before the timing experiment declared no clock, so the report
    // claims none rather than assuming the default on its behalf.
    const historical = buildRunReport(run(), brief);
    expect(historical).not.toContain("Business time advanced");
  });

  it("keeps an evidenced task failure separate from required review", () => {
    const value = run();
    value.verdict = { ...value.verdict!, outcome: "fail", score: 0,
      checklist: [criterion({ status: "failed", evidence: "00107 was changed to Include without review." })] };
    const markdown = buildRunReport(value, brief);
    expect(markdown).toContain("failed its declared requirements");
    expect(markdown).toContain("Requirements not met");
    expect(markdown).toContain("Include without review");
    expect(markdown).not.toContain("could not be left to run this workflow alone");
  });

  it.each(["failed", "aborted"] as const)("withholds stale scores and findings on a %s run", status => {
    const markdown = buildRunReport(run({ status, error: "provider interrupted" }), brief);
    expect(markdown).not.toContain("passed its checked requirements");
    expect(markdown).not.toContain("**Checklist score**");
    expect(markdown).not.toContain("What it got right");
    expect(markdown).toContain("not an agent task-failure finding");
    expect(markdown).toContain("Prepared an email draft");
  });

  it("separates simulated clock coverage from runtime, human work and cost savings", () => {
    const markdown = buildRunReport(run(), brief);
    expect(markdown).toContain("1h between first and last recorded tick");
    expect(markdown).toContain("Recorded elapsed time** | 1m 00s");
    expect(markdown).not.toContain("of work");
    expect(markdown).not.toContain("Worked unsupervised");
    expect(markdown).toContain("not measured human working time");
  });

  it("does not turn missing workbook evidence into an agent error or a never-delivered event", () => {
    const gap = criterion({ status: "notApplicable", evidence: harnessDefectEvidence("no excel snapshot in this run") });
    expect(criterionFault(gap)?.kind).toBe("not-captured");
    const generic = criterionFault(criterion({ status: "notApplicable", evidence: harnessDefectEvidence("checker could not resolve the stored row") }))!;
    expect(generic.kind).toBe("unmeasured");
    expect(faultPhrase([{ fault: generic }])).toBe("we could not check");
    const value = run();
    value.verdict = { ...value.verdict!, outcome: "inconclusive", checklist: [gap] };
    const markdown = assembleRunDocument({ run: value, brief, spec: null });
    expect(markdown).toContain("What this test did not do properly");
    expect(markdown).toContain("no excel snapshot");
    expect(markdown).not.toContain("Requirements not met");
  });

  it("identifies partial saved app-state coverage, including when all action lists fitted", () => {
    const judge = { runId: "r", judgedAt: 1, model: "fixture/judge", taskUnderstanding: "Review", autonomyScore: 1,
      summary: "Review", findings: [], otherFindings: [], answers: [], coverage: {
        steps: { shown: 2, total: 2 }, timeline: { shown: 2, total: 2 }, narration: { shown: 2, total: 2 },
        finalState: { shown: 1, total: 3 }, fraction: 1 / 3, complete: false,
      } };
    expect(judgeSight(judge)).toMatchObject({ kind: "partial", missing: [{ what: "saved app-state records", shown: 1, total: 3 }] });
  });
});

describe("the download and GUI document use the same immutable run evidence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sonata-report-"));
  const previous = process.env.SONATA_RUNS_DIR;
  afterAll(() => {
    if (previous === undefined) delete process.env.SONATA_RUNS_DIR;
    else process.env.SONATA_RUNS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports the full document with captured scenario timing and capture warnings, without changing the artifact", async () => {
    process.env.SONATA_RUNS_DIR = dir;
    const value = run({ status: "aborted" });
    const file = path.join(dir, `${value.runId}.json`);
    const saved = JSON.stringify({ ...value, spec: spec() });
    writeFileSync(file, saved);
    const document = loadRunDocument(value.runId)!;
    const response = await download(new Request("http://localhost/report"), { params: Promise.resolve({ runId: value.runId }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(document.markdown);
    expect(document.markdown).toContain("2 of 8 ticks");
    expect(document.markdown).toContain("We did not record enough");
    expect(document.markdown).toContain("Where the day ended up");
    expect(document.markdown).toContain("Saved scenario version");
    expect(readFileSync(file, "utf8")).toBe(saved);
  });
});
