import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CriterionResult,
  EpisodeJudgeReport,
  EpisodeRun,
  EpisodeSpec,
  TickRecord,
} from "@sonata/core";

// WHAT A JUDGE-OFF DAY IS ALLOWED TO SAY.
//
// `scoreRun` is the deterministic half of a verdict, and `judged` criteria are
// not its to decide. It used to leave them out of the checklist altogether, which
// was right for as long as a judge came along afterwards and answered them — and
// wrong the moment one did not. `sess_mu1g6lfw_l49y`, a 6-tick session with the
// judge disabled, published a checklist with tw-c03 (a `must`, weight 3) and
// tw-c09 simply missing: not pending, not unmeasured, just gone, and a reader
// could not tell them from criteria the day never had.
//
// These pin the two halves of the fix. Without a judge report, every criterion
// written for the judge is a `notApplicable` row saying the judge did not run and
// that this is not the agent's failure; with one, the judge owns those criteria
// and the checklist is exactly what it was. And because the same call now hands
// `runChecklist` how long the day ran, a deadline the day never reached is
// unmeasured here too, not the agent's failure (`sess_mtwxabdk_1lsy`, tw-c01).
//
// Sandboxed: `verdict.ts` sits next to the platform's database module, which
// resolves its file off the working directory.

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-verdict-"));
process.env.SONATA_RUNS_DIR = path.join(sandbox, "runs");
process.chdir(sandbox);

const { scoreRun } = await import("../src/lib/engine/verdict");
const { readRun, updateRunJudge } = await import("../app/results/_lib/artifacts");

// ---------------------------------------------------------------------------

/** One tick in which the agent did something, so the run counts as executed. */
function tick(n: number, over: Partial<TickRecord> = {}): TickRecord {
  return {
    tick: n,
    simTimeISO: `2026-09-17T09:${String(n * 15).padStart(2, "0")}:00Z`,
    startedAt: 1000 + n * 100,
    endedAt: 1099 + n * 100,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [
      {
        kind: "tool",
        seq: n + 1,
        at: 1001 + n * 100,
        twin: "gmail",
        name: "list_threads",
        args: {},
        resultSummary: "one thread",
        isMutation: false,
      },
    ],
    notes: [],
    ...over,
  };
}

/** A four-tick day: the delivery thread lands at t0, and nothing else happens. */
function run(over: Partial<EpisodeRun> = {}): EpisodeRun {
  const thread = {
    threadId: "T1",
    subject: "Delivery slot for the Thursday pallets",
    from: "marta@client.test",
    date: 900,
    labels: ["INBOX", "UNREAD"],
    unread: true,
    starred: false,
    count: 1,
  };
  return {
    runId: "run_verdict_fixture",
    specId: "delivery-day",
    specTitle: "Delivery day",
    model: "fixture/model",
    status: "done",
    startedAt: 1000,
    endedAt: 2000,
    ticks: [
      tick(0, {
        beatsFired: [
          {
            beatId: "b-delivery",
            ref: "delivery",
            twin: "gmail",
            kind: "email",
            summary: "Marta asked about the delivery slot",
            handle: { twin: "gmail", id: "M1", containerId: "T1" },
          },
        ],
      }),
      tick(1),
      tick(2),
      tick(3),
    ],
    snapshots: {
      gmail: {
        before: { twin: "gmail", capturedAt: 1, labels: [], threads: [thread], drafts: [] },
        after: { twin: "gmail", capturedAt: 2, labels: [], threads: [thread], drafts: [] },
      },
    },
    audit: [],
    verdict: null,
    ...over,
  };
}

/** A 32-tick scenario whose checklist mixes checked and judged criteria. */
function spec(): EpisodeSpec {
  return {
    id: "delivery-day",
    title: "Delivery day",
    task: "Keep Marta informed.",
    story: "A client is waiting on a delivery slot.",
    clock: { startISO: "2026-09-17T09:00:00+01:00", ticks: 32, simMinutesPerTick: 15 },
    world: {
      business: { name: "Northwind Freight", description: "Freight broker", industry: "logistics", size: 40 },
      cast: [
        {
          id: "sam",
          name: "Sam Okafor",
          email: "sam@northwind.test",
          slackUserId: "U01SAM",
          role: "Ops Lead",
          relationship: "self",
          voice: "brisk",
        },
      ],
      channels: [],
      mailboxOwner: "sam",
    },
    beats: [
      {
        id: "b-delivery",
        tick: 0,
        ref: "delivery",
        twin: "gmail",
        kind: "email",
        payload: { from: "marta", to: ["sam"], subject: "Delivery slot for the Thursday pallets", body: "Which slot?" },
      },
    ],
    director: { maxEventsPerTick: 1, personas: [], offLimits: [], style: "concise" },
    success: {
      // A judged criterion FIRST, so the test can tell "listed where the spec put
      // it" apart from "appended after the checked rows".
      checklist: [
        {
          id: "c03",
          twin: "excel",
          kind: "judged",
          severity: "must",
          weight: 3,
          description: "Read and use the supplied workbook, not an invented population.",
        },
        {
          id: "c01",
          twin: "gmail",
          kind: "replied",
          ref: "delivery",
          before: "t12",
          severity: "must",
          weight: 1,
          description: "Marta receives a reply on the delivery thread before noon.",
        },
        {
          id: "c09",
          twin: "calendar",
          kind: "judged",
          severity: "should",
          weight: 1,
          description: "Prepare specific questions before each client call.",
        },
      ],
      judgeQuestions: [],
    },
    termination: { stopWhenAllMustPass: false, idleTicks: 6, maxWallClockMs: 0 },
  };
}

function report(): EpisodeJudgeReport {
  return {
    runId: "run_verdict_fixture",
    judgedAt: 3000,
    model: "fixture/judge",
    taskUnderstanding: "Keep Marta informed.",
    autonomyScore: 0.5,
    summary: "It read the thread and did nothing.",
    findings: [],
    otherFindings: [],
    answers: [],
  };
}

function byId(checklist: CriterionResult[]): Map<string, CriterionResult> {
  return new Map(checklist.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------------

describe("scoring a day the judge never read", () => {
  it("keeps unmeasured criteria and unreached deadlines when the saved report is opened", () => {
    const played = run();
    const scored = scoreRun(played, spec());
    mkdirSync(process.env.SONATA_RUNS_DIR!, { recursive: true });
    writeFileSync(path.join(process.env.SONATA_RUNS_DIR!, `${played.runId}.json`),
      JSON.stringify({ ...played, spec: spec(), verdict: scored.verdict }));

    const opened = readRun(played.runId)!;
    expect(opened.verdict?.checklist).toEqual(scored.checklist);
    expect(opened.verdict?.outcome).toBe("inconclusive");

    // Attaching a judge report must remove the "judge did not run" placeholders
    // on both the immediate return value and the next artifact read.
    const judged = updateRunJudge(played.runId, report());
    expect(judged?.checklist.map(c => c.id)).toEqual(["c01"]);
    expect(readRun(played.runId)?.verdict?.checklist).toEqual(judged?.checklist);
    expect(judged?.checklist[0].status).toBe("notApplicable");
    // If the judge's separate file saved but embedding it failed, that file
    // still supplies the report and must prevent false unjudged placeholders.
    writeFileSync(path.join(process.env.SONATA_RUNS_DIR!, `${played.runId}.json`),
      JSON.stringify({ ...played, spec: spec(), verdict: scored.verdict }));
    expect(readRun(played.runId)?.verdict?.checklist).toEqual(judged?.checklist);
  });

  it("gives every judged criterion a row that says the judge did not run", () => {
    const { checklist, verdict } = scoreRun(run(), spec());

    // Every criterion, in the spec's own order — a pending row is not an appendix.
    expect(checklist.map((c) => c.id)).toEqual(["c03", "c01", "c09"]);
    for (const id of ["c03", "c09"]) {
      const row = byId(checklist).get(id)!;
      expect(row.status).toBe("notApplicable");
      expect(row.kind).toBe("judged");
      expect(row.evidence).toContain("needs the narrative judge");
      expect(row.evidence).toContain("did not run for this run");
      expect(row.evidence).toContain("not the agent's failure");
    }
    // Severity and weight ride along, so the page can still say WHICH must is pending.
    expect(byId(checklist).get("c03")).toMatchObject({ severity: "must", weight: 3 });

    // A `must` nobody assessed means the run has not been graded — not that it failed.
    expect(verdict?.outcome).toBe("inconclusive");
    expect(verdict?.judge).toBeNull();
  });

  it("calls a deadline the day never reached unmeasured, not failed", () => {
    // Four ticks ran; c01 allowed until t12. Silence over t0..t3 is not a verdict
    // on t4..t11, and `scoreRun` now tells the checker how long the day was.
    const { checklist } = scoreRun(run(), spec());
    const c01 = byId(checklist).get("c01")!;
    expect(c01.status).toBe("notApplicable");
    expect(c01.evidence).toContain("no reply landed");
    expect(c01.evidence).toContain("the day ended after tick 3");
    expect(c01.evidence).toContain("allowed until t12");
  });

  it("does not grow the checklist when a scored run is scored again", () => {
    const first = scoreRun(run(), spec());
    const again = scoreRun(run({ verdict: first.verdict }), spec());
    expect(again.checklist).toEqual(first.checklist);
  });

  it("adds the rows to stored rows an older scorer left them out of", () => {
    // A verdict written before this fix: c01 decided, the judged criteria absent.
    const stored: CriterionResult[] = [
      {
        id: "c01",
        description: "Marta receives a reply on the delivery thread before noon.",
        twin: "gmail",
        kind: "replied",
        severity: "must",
        weight: 1,
        status: "passed",
        evidence: "replied: [audit 1]",
        tick: 2,
      },
    ];
    const { checklist } = scoreRun(
      run({
        verdict: { outcome: "pass", score: 1, autonomy: 1, checklist: stored, judge: null,
          cost: { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 } },
      }),
      spec(),
    );
    // The stored row is the record and is not re-decided; the missing ones appear.
    expect(checklist.map((c) => c.id)).toEqual(["c03", "c01", "c09"]);
    expect(byId(checklist).get("c01")).toEqual(stored[0]);
  });
});

describe("scoring a day the judge has read", () => {
  it("leaves the judge's criteria to the judge", () => {
    const judged = run({
      verdict: {
        outcome: "inconclusive",
        score: 0,
        autonomy: 0,
        checklist: [],
        judge: report(),
        cost: { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 },
      },
    });
    const { checklist, verdict } = scoreRun(judged, spec());
    // Exactly the deterministic rows, as before this fix: the judge's report is
    // the answer to c03 and c09, and a "did not run" row beside it would be false.
    expect(checklist.map((c) => c.id)).toEqual(["c01"]);
    expect(verdict?.judge).toEqual(report());
  });

  it("keeps stored rows exactly as they were", () => {
    const stored: CriterionResult[] = [
      {
        id: "c01",
        description: "Marta receives a reply on the delivery thread before noon.",
        twin: "gmail",
        kind: "replied",
        severity: "must",
        weight: 1,
        status: "failed",
        evidence: "no reply landed",
      },
    ];
    const { checklist } = scoreRun(
      run({
        verdict: { outcome: "fail", score: 0, autonomy: 0, checklist: stored, judge: report(),
          cost: { usd: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0 } },
      }),
      spec(),
    );
    expect(checklist).toEqual(stored);
  });
});
