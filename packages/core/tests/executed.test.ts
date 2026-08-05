import { describe, expect, it } from "vitest";
import { agentToolCalls, runExecuted, runExecution } from "../src/executed";
import type { AgentStep, RunStatus, TickRecord } from "../src/types/run";

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
