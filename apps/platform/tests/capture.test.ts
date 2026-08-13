import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  EpisodeRun,
  EpisodeSpec,
  TickRecord,
  TwinAuditRow,
  TwinName,
  TwinSnapshot,
} from "@sonata/core";
import type { RunEvidence } from "../app/results/_lib/artifacts";

// WHAT A FINISHED DAY IS ALLOWED TO LOOK LIKE.
//
// Two runs on one afternoon, both `status: "done"`, neither carrying an error:
// one filed three snapshot pairs and forty-two audit rows, the other filed
// `snapshots: {}` and no log at all. The second was never driven by the engine —
// it came from the stand-in tick loop behind `POST /api/runs`, which plays a
// scripted day with no clone attached — but nothing in the artifact said so, and
// a reader had a day nobody photographed in front of them wearing the face of a
// day in which nothing happened.
//
// So these pin the funnel, which is where that is decidable: `mirrorRunFinish`
// is the one write every producer in the product finishes through, and a run
// that was never observed must come out of it saying so, per twin, in words.
//
// Everything below is offline and lands in a temp cwd — `db.ts` resolves its
// database against `process.cwd()` at import time, so the chdir has to happen
// before the dynamic imports under it.

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-capture-"));
process.env.SONATA_RUNS_DIR = path.join(sandbox, "runs");
process.chdir(sandbox);

const { mirrorRunFinish } = await import("../app/api/_lib/mirror");
const { describeEvidence } = await import("../app/results/_lib/artifacts");
const { explainUnpaired } = await import("../src/lib/engine/episode");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An empty capture of any surface. A switch rather than a default arm, so a twin
 * added to `TwinName` cannot silently be photographed as a calendar — these
 * tests are about whether a run was observed at all, and a fixture wearing the
 * wrong twin's shape would pass while proving nothing.
 */
const snapshot = (twin: TwinName): TwinSnapshot => {
  switch (twin) {
    case "gmail":
      return { twin, capturedAt: 1, labels: [], threads: [], drafts: [] };
    case "slack":
      return { twin, capturedAt: 1, channels: [], messages: [] };
    case "calendar":
      return { twin, capturedAt: 1, events: [] };
    case "attio":
      return { twin, capturedAt: 1, records: [], notes: [], tasks: [] };
    case "google-docs":
      return { twin, capturedAt: 1, documents: [] };
    case "google-ads":
      return { twin, capturedAt: 1, campaigns: [] };
    case "linkedin":
      return { twin, capturedAt: 1, posts: [], comments: [] };
  }
};

function auditRow(id: number, twin: TwinName): TwinAuditRow {
  return {
    id,
    twin,
    ts: 1_700_000_000_000 + id,
    method: "POST",
    endpoint: "/api/messages",
    actionType: "send",
    targetType: "thread",
    targetId: `t${id}`,
    summary: "sent one thing",
  };
}

function tick(n: number, notes: string[] = []): TickRecord {
  return {
    tick: n,
    simTimeISO: `2026-08-06T${String(9 + n).padStart(2, "0")}:00:00.000Z`,
    startedAt: 1_700_000_000_000 + n,
    endedAt: 1_700_000_000_500 + n,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [
      { kind: "tool", seq: n + 1, at: 1_700_000_000_100 + n, twin: "gmail", name: "gmail.send", args: {}, resultSummary: "sent", isMutation: true },
    ],
    notes,
  };
}

function spec(): EpisodeSpec {
  return {
    id: "ep-capture",
    title: "A day with a guard on it",
    story: "Three disputes and a budget.",
    task: "Handle them.",
    world: {
      business: { name: "Momentum", description: "support desk", industry: "SaaS", size: 30 },
      cast: [
        {
          id: "marcus",
          name: "Marcus Webb",
          email: "marcus@momentum.test",
          slackUserId: "U01M",
          role: "Support",
          relationship: "owner",
          voice: "brisk",
        },
      ],
      channels: [{ id: "C01", name: "support", purpose: "the day", members: ["marcus"], isPrivate: false }],
      mailboxOwner: "marcus",
    },
    clock: { startISO: "2026-08-06T09:00:00Z", ticks: 12, simMinutesPerTick: 15 },
    beats: [],
    director: { maxEventsPerTick: 1, personas: [], offLimits: [], style: "short" },
    // Two surfaces named by criteria, which is where `mirrorRunFinish` gets the
    // attached set from when the caller does not say — the honest floor, and the
    // shape the stand-in's artifacts actually have on disk.
    success: {
      checklist: [
        { id: "c1", description: "the client got an answer", twin: "gmail", kind: "replied", weight: 1, severity: "must" },
        { id: "c2", description: "the team was told", twin: "slack", kind: "posted", weight: 1, severity: "should" },
      ],
      judgeQuestions: [],
    },
    termination: { stopWhenAllMustPass: false, idleTicks: 3, maxWallClockMs: 0 },
  };
}

function run(over: Partial<EpisodeRun> = {}): EpisodeRun {
  return {
    runId: `run_test_${Math.random().toString(36).slice(2, 8)}`,
    specId: "ep-capture",
    specTitle: "A day with a guard on it",
    model: "anthropic/claude-haiku-4.5",
    status: "done",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    ticks: [tick(0), tick(1)],
    snapshots: {},
    verdict: null,
    ...over,
  };
}

/** File a run the way every producer does, and read back what landed on disk. */
function file(input: Parameters<typeof mirrorRunFinish>[0]): EpisodeRun & { evidence: RunEvidence } {
  mirrorRunFinish(input);
  const file = path.join(process.env.SONATA_RUNS_DIR ?? "", `${input.run.runId}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as EpisodeRun & { evidence: RunEvidence };
}

// ---------------------------------------------------------------------------

describe("a day that stopped at a guard", () => {
  it("still files everything it had captured up to the guard", () => {
    // The shape the engine hands back when `stopReason` fires mid-day: fewer
    // ticks than the clock planned, a note saying why, and a full capture — the
    // guard breaks the tick loop and the snapshots are taken after it, so a
    // truncated day is still an observed one.
    const artifact = file({
      run: run({
        ticks: [tick(0), tick(1), tick(2, ["run stopped early: the agent did nothing for 3 consecutive interval(s)"])],
        snapshots: {
          gmail: { before: snapshot("gmail"), after: snapshot("gmail") },
          slack: { before: snapshot("slack"), after: snapshot("slack") },
        },
        audit: [auditRow(1, "gmail"), auditRow(2, "slack")],
      }),
      spec: spec(),
      checklist: [],
      twins: ["gmail", "slack"],
      observed: true,
    });

    expect(Object.keys(artifact.snapshots).sort()).toEqual(["gmail", "slack"]);
    expect(artifact.audit).toHaveLength(2);
    expect(artifact.evidence.complete).toBe(true);
    expect(artifact.evidence.twins.every((t) => t.before && t.after)).toBe(true);
  });
});

describe("a day nobody photographed", () => {
  it("is filed as one, rather than as a day in which nothing happened", () => {
    // No `observed`, which is what every caller that never touched a clone
    // passes: the stand-in tick loop behind POST /api/runs writes exactly this.
    const artifact = file({ run: run(), spec: spec(), checklist: [] });

    expect(artifact.evidence.complete).toBe(false);
    expect(artifact.evidence.summary).toContain("No clone was ever asked for its state");
    expect(artifact.evidence.summary).toContain("about the harness, not about the agent");
    // Per twin, by name — an operator reading one row has to be able to tell
    // which surface they are missing without reading the prose.
    for (const twin of artifact.evidence.twins) {
      expect(twin.note).toContain(`nothing asked the ${twin.twin} clone`);
    }
  });

  it("does not describe a clone that was asked as one that was never asked", () => {
    const artifact = file({
      run: run(),
      spec: spec(),
      checklist: [],
      twins: ["gmail"],
      observed: true,
    });

    expect(artifact.evidence.summary).not.toContain("No clone was ever asked");
    expect(artifact.evidence.twins[0]?.note).toContain("neither snapshot came back");
  });

  it("keeps the clone's own words when capture failed for a reason", () => {
    const artifact = file({
      run: run(),
      spec: spec(),
      checklist: [],
      twins: ["gmail"],
      observed: true,
      captureNotes: { gmail: "the gmail clone was unreachable at 11:15 (fetch failed)" },
    });

    expect(artifact.evidence.twins[0]?.note).toBe(
      "the gmail clone was unreachable at 11:15 (fetch failed)",
    );
  });
});

describe("describeEvidence", () => {
  it("refuses to call a run complete when nothing ever looked", () => {
    const evidence = describeEvidence({
      twins: ["gmail"],
      snapshots: { gmail: { before: snapshot("gmail"), after: snapshot("gmail") } },
      audit: [auditRow(1, "gmail")],
      observed: false,
    });
    expect(evidence.complete).toBe(false);
  });

  it("names the missing half of a pair", () => {
    const evidence = describeEvidence({
      twins: ["gmail", "slack"],
      snapshots: { gmail: { before: snapshot("gmail"), after: snapshot("gmail") } },
      audit: [auditRow(1, "gmail")],
      observed: true,
    });
    expect(evidence.complete).toBe(false);
    expect(evidence.twins.find((t) => t.twin === "gmail")?.note).toBeUndefined();
    expect(evidence.twins.find((t) => t.twin === "slack")?.note).toContain("neither snapshot came back");
  });
});

describe("explainUnpaired", () => {
  it("says why a closing snapshot has nothing to be diffed against", () => {
    // A cancel at tick 0 of a run that seeds inside the loop: the loop unwinds
    // before its own capture, so `before` is empty and nothing threw on the way.
    const capture = {
      before: {},
      after: { gmail: snapshot("gmail"), slack: snapshot("slack") },
      audit: [],
      notes: {} as Partial<Record<TwinName, string>>,
    };
    explainUnpaired(capture, ["gmail", "slack"]);
    expect(capture.notes.gmail).toContain("the day ended before an opening snapshot of gmail was taken");
    expect(capture.notes.slack).toContain("the day ended before an opening snapshot of slack was taken");
  });

  it("leaves a whole pair and a reason already given alone", () => {
    const capture = {
      before: { gmail: snapshot("gmail"), slack: snapshot("slack") },
      after: { gmail: snapshot("gmail") },
      audit: [],
      notes: { slack: "the slack clone was unreachable at 11:15 (fetch failed)" } as Partial<
        Record<TwinName, string>
      >,
    };
    explainUnpaired(capture, ["gmail", "slack"]);
    expect(capture.notes.gmail).toBeUndefined();
    expect(capture.notes.slack).toBe("the slack clone was unreachable at 11:15 (fetch failed)");
  });
});
