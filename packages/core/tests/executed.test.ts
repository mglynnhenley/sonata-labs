import { describe, expect, it } from "vitest";
import {
  agentToolCalls,
  harnessDefectEvidence,
  isHarnessDefect,
  runExecuted,
  runExecution,
  runTruncation,
  withheld,
} from "../src/executed";
import type { Beat } from "../src/types/episode";
import type { AgentStep, BeatFired, RunStatus, TickRecord } from "../src/types/run";

// The gate every score in this product now stands behind. It exists because four
// runs that crashed before their first tick scored 18–25% — one of them higher
// than a run with 33 real actions — by passing the negative half of a checklist
// for free. Scoring cannot fix that; only refusing to score can.

function tool(seq: number): AgentStep {
  return {
    kind: "tool",
    seq,
    at: 1000,
    twin: "gmail",
    name: "gmail.send_reply",
    args: {},
    resultSummary: "sent",
    isMutation: true,
  };
}

function tick(over: Partial<TickRecord> = {}): TickRecord {
  return {
    tick: 0,
    simTimeISO: "2026-03-02T09:00:00.000Z",
    startedAt: 1000,
    endedAt: 1100,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [],
    notes: [],
    ...over,
  };
}

function run(status: RunStatus, ticks: TickRecord[]) {
  return { status, ticks };
}

describe("runExecution", () => {
  it("passes a finished day the agent worked", () => {
    const r = runExecution(run("done", [tick({ agentSteps: [tool(1)] })]));
    expect(r).toMatchObject({ executed: true, ticks: 1, toolCalls: 1, reason: null });
  });

  it("refuses a run that crashed before it recorded a tick", () => {
    const r = runExecution(run("failed", []));
    expect(r.executed).toBe(false);
    expect(r.reason).toContain("the agent never ran");
  });

  it("refuses a finished day with no ticks at all", () => {
    const r = runExecution(run("done", []));
    expect(r.executed).toBe(false);
    expect(r.reason).toContain("never started");
  });

  it("refuses a day the agent ticked through without touching a twin", () => {
    // Thoughts are not work. This is the run that scored 18% for sleeping.
    const thinking = tick({
      agentSteps: [{ kind: "thought", seq: 1, at: 1000, text: "Nothing new. Waiting." }],
    });
    const r = runExecution(run("done", [thinking, thinking]));
    expect(r).toMatchObject({ executed: false, ticks: 2, toolCalls: 0 });
    expect(r.reason).toContain("never touched a twin");
  });

  it("does not count an escalation as having done the job", () => {
    const handedBack = tick({
      agentSteps: [{ kind: "escalation", seq: 1, at: 1000, text: "You decide." }],
    });
    expect(runExecuted(run("done", [handedBack]))).toBe(false);
  });

  it("refuses a day that was stopped or is still going", () => {
    const worked = [tick({ agentSteps: [tool(1)] })];
    // A half-day cannot be scored against a whole day's checklist: the criteria
    // it never reached would be counted as failures it never committed.
    expect(runExecution(run("aborted", worked)).reason).toContain("stopped");
    expect(runExecution(run("running", worked)).reason).toContain("still going");
  });
});

describe("agentToolCalls", () => {
  it("counts tool steps across every tick and nothing else", () => {
    const ticks = [
      tick({ agentSteps: [tool(1), { kind: "thought", seq: 2, at: 1, text: "hm" }] }),
      tick({ tick: 1, agentSteps: [tool(3), tool(4)] }),
    ];
    expect(agentToolCalls(ticks)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The twelve-of-thirty-two day. `run_msg6yuxd_6tsw` executed 12 of the 32 ticks
// its scenario declares and was graded against all 32: the customer who writes at
// t20 never wrote, and the agent was marked critical for ignoring them.
// ---------------------------------------------------------------------------

function email(id: string, at: number, ref: string, body: string): Beat {
  return {
    id,
    tick: at,
    ref,
    twin: "gmail",
    kind: "email",
    payload: { from: "priya", to: ["marcus"], subject: "Refund approvals", body },
  };
}

function fired(beatId: string, ref: string, over: Partial<BeatFired> = {}): BeatFired {
  return {
    beatId,
    ref,
    twin: "gmail",
    kind: "email",
    handle: { twin: "gmail", id: `M-${beatId}`, containerId: `T-${beatId}` },
    summary: `${ref} arrived`,
    ...over,
  };
}

/** The day as the scenario declares it: three beats, thirty-two ticks. */
const SPEC = {
  clock: { ticks: 32 },
  beats: [
    email("b1", 1, "arun_refund", "We have been waiting since Friday for the $8,500 refund."),
    email("b2", 12, "priya_update", "Derek approved Vertex: $5,000 (NOT $8,500)."),
    email("b3", 27, "arun_second", "Still no response from you."),
  ],
};

/** Twelve ticks ran, and only the beat at t1 ever reached the agent. */
const SHORT_DAY = {
  ticks: [
    tick({ tick: 0 }),
    tick({ tick: 1, beatsFired: [fired("b1", "arun_refund")] }),
    ...Array.from({ length: 10 }, (_, i) => tick({ tick: i + 2 })),
  ],
};

describe("runTruncation", () => {
  it("reads the short day off the artifact, and names every beat that never fired", () => {
    const t = runTruncation(SHORT_DAY, SPEC);

    expect(t).toMatchObject({ truncated: true, executedTicks: 12, scheduledTicks: 32 });
    expect(t.unfiredRefs).toEqual(["priya_update", "arun_second"]);
    expect(t.unfired.map((b) => b.why)).toEqual(["cut-short", "cut-short"]);
  });

  it("says how much of the day ran and what the agent was therefore never shown", () => {
    // The verdict has to carry both numbers. "Fail" against a checklist written for
    // 32 ticks is a claim about a day that did not happen.
    const notice = runTruncation(SHORT_DAY, SPEC).notice ?? "";
    expect(notice).toContain("12 of the 32 ticks");
    expect(notice).toContain("priya_update");
    expect(notice).toContain("arun_second");
    expect(notice).toContain("never shown");
  });

  it("leaves a day that ran to its end alone", () => {
    const whole = {
      ticks: Array.from({ length: 32 }, (_, i) =>
        tick({
          tick: i,
          beatsFired: SPEC.beats.filter((b) => b.tick === i).map((b) => fired(b.id, b.ref ?? "")),
        }),
      ),
    };
    const t = runTruncation(whole, SPEC);
    expect(t).toMatchObject({ truncated: false, notice: null });
    expect(t.unfired).toEqual([]);
  });

  it("separates a beat the twin refused from one the short day never reached", () => {
    const refused = {
      ticks: [
        tick({ tick: 0 }),
        tick({ tick: 1, beatsFired: [fired("b1", "arun_refund", { handle: undefined, error: "502 from gmail" })] }),
        ...Array.from({ length: 10 }, (_, i) => tick({ tick: i + 2 })),
      ],
    };
    const t = runTruncation(refused, SPEC);
    expect(t.unfired.map((b) => [b.ref, b.why])).toEqual([
      ["arun_refund", "inject-failed"],
      ["priya_update", "cut-short"],
      ["arun_second", "cut-short"],
    ]);
  });

  it("counts a beat its own tick ran past as skipped, not as a short day", () => {
    // Every tick ran; the engine simply fired nothing. Still ours, still not the
    // agent's — but a different bug, and the row has to say which.
    const whole = { ticks: Array.from({ length: 32 }, (_, i) => tick({ tick: i })) };
    const t = runTruncation(whole, { ...SPEC, beats: [SPEC.beats[0]] });
    expect(t.truncated).toBe(false);
    expect(t.unfired[0].why).toBe("skipped");
    expect(t.notice).toContain("never reached the agent");
  });

  it("takes the shorter of the clock and the spec's own tick cap", () => {
    const capped = runTruncation(SHORT_DAY, { ...SPEC, termination: { maxTicks: 12 } });
    expect(capped).toMatchObject({ truncated: false, scheduledTicks: 12 });
  });
});

describe("withheld", () => {
  it("finds the beat that is the only place a required phrase was ever spoken", () => {
    // The criterion asks the agent to name the approved amount. The approval arrives
    // at t12. The run stopped at t11.
    const t = runTruncation(SHORT_DAY, SPEC);
    expect(withheld(t, "$5,000")?.ref).toBe("priya_update");
  });

  it("says nothing when the day the agent saw carried the phrase too", () => {
    const t = runTruncation(SHORT_DAY, SPEC);
    expect(withheld(t, "$8,500")).toBeNull();
  });

  it("says nothing about a phrase no beat ever carried — that one is the agent's to write", () => {
    const t = runTruncation(SHORT_DAY, SPEC);
    expect(withheld(t, "we are sorry for the delay")).toBeNull();
  });

  it("will not call a two-character phrase withheld", () => {
    const t = runTruncation(SHORT_DAY, SPEC);
    expect(withheld(t, "NO")).toBeNull();
  });
});

describe("isHarnessDefect", () => {
  it("tells our defect apart from a criterion nothing could settle", () => {
    const ours = { status: "notApplicable" as const, evidence: harnessDefectEvidence("t20 never fired") };
    const blind = { status: "notApplicable" as const, evidence: "no gmail snapshot in this run" };
    expect(isHarnessDefect(ours)).toBe(true);
    expect(isHarnessDefect(blind)).toBe(false);
  });

  it("is never true of a decided criterion, whatever the evidence says", () => {
    const failed = { status: "failed" as const, evidence: harnessDefectEvidence("t20 never fired") };
    expect(isHarnessDefect(failed)).toBe(false);
  });
});
