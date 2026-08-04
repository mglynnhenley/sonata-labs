import { describe, it, expect } from "vitest";
import type { AgentStep, DirectorEvent, TickRecord } from "@sonata/core";
import {
  adaptersForSpec,
  didSomething,
  runEpisode,
  specWarnings,
  stopReason,
  type RunOptions,
} from "../src/run";
import type { Agent, AgentContext } from "../src/agent";
import type { Director } from "../src/director";
import { auditRow, beat, fakeAdapter, spec, type FakeAdapter } from "./fixtures";

// The tick loop. Everything here is about ONE property: the order in which a
// tick's three actors run, and the fact that the artifact it leaves behind says
// exactly what happened, in that order.

/** Records the order everything happened in, across all three actors. */
function harness() {
  const order: string[] = [];
  const seen: AgentContext[] = [];

  const gmail = fakeAdapter("gmail");
  const slack = fakeAdapter("slack");
  const originalInject = gmail.inject.bind(gmail);
  gmail.inject = (body, ctx) => {
    order.push(`inject:${body.kind}@${ctx.atISO.slice(11, 16)}`);
    return originalInject(body, ctx);
  };

  let events: DirectorEvent[] = [];
  const director: Director = {
    react: (ctx) => {
      order.push(`director@${ctx.tick}`);
      const next = events;
      events = [];
      return Promise.resolve(next);
    },
    lastNote: () => undefined,
  };

  let steps: AgentStep[] = [];
  const agent: Agent = {
    act: (ctx) => {
      order.push(`agent@${ctx.tick}`);
      seen.push(ctx);
      const next = steps;
      steps = [];
      return Promise.resolve(next);
    },
    wrapUp: () => {
      order.push("wrapUp");
      return Promise.resolve("done");
    },
  };

  return {
    order,
    seen,
    gmail,
    slack,
    director,
    agent,
    nextEvents(e: DirectorEvent[]) {
      events = e;
    },
    nextSteps(s: AgentStep[]) {
      steps = s;
    },
  };
}

const toolStep = (seq: number): AgentStep => ({
  kind: "tool",
  seq,
  at: 0,
  twin: "gmail",
  name: "send_reply",
  args: { body: "on its way" },
  resultSummary: "sent reply on m1",
  isMutation: true,
});

function options(h: ReturnType<typeof harness>, over: Partial<RunOptions> = {}): RunOptions {
  let clock = 1_000;
  return {
    spec: spec({ beats: [beat({ id: "b0", tick: 1, ref: "opener" })] }),
    adapters: [h.gmail, h.slack],
    agent: h.agent,
    director: h.director,
    model: "test/model",
    runId: "run-1",
    now: () => (clock += 10),
    ...over,
  };
}

describe("runEpisode ordering", () => {
  it("runs beats, then the director, then the agent — every tick, in that order", async () => {
    const h = harness();
    await runEpisode(options(h));
    // Beats only exist on tick 1, but the director and agent run on all four.
    expect(h.order).toEqual([
      "director@0",
      "agent@0",
      "inject:email@09:15",
      "director@1",
      "agent@1",
      "director@2",
      "agent@2",
      "director@3",
      "agent@3",
      "wrapUp",
    ]);
  });

  it("injects director events before the agent sees the tick", async () => {
    const h = harness();
    h.nextEvents([
      {
        id: "dir-0-0",
        personId: "dana",
        reason: "chasing",
        twin: "gmail",
        kind: "email",
        payload: { from: "dana", to: ["priya"], subject: "?", body: "well?" },
      },
    ]);
    const result = await runEpisode(options(h));
    expect(h.order.slice(0, 3)).toEqual(["director@0", "inject:email@09:00", "agent@0"]);
    expect(result.run.ticks[0].directorEvents[0].handle).toEqual({
      twin: "gmail",
      id: "gmail-1",
      containerId: "gmail-c",
    });
  });

  it("dates every injection with simulated time, never the wall clock", async () => {
    const h = harness();
    const result = await runEpisode(options(h));
    expect(h.gmail.injected).toEqual([{ kind: "email", atISO: "2026-08-04T09:15:00.000Z" }]);
    expect(result.run.ticks.map((t) => t.simTimeISO)).toEqual([
      "2026-08-04T09:00:00.000Z",
      "2026-08-04T09:15:00.000Z",
      "2026-08-04T09:30:00.000Z",
      "2026-08-04T09:45:00.000Z",
    ]);
  });

  it("tells the agent that something arrived and nothing about what it says", async () => {
    const h = harness();
    await runEpisode(options(h));
    expect(h.seen.map((c) => c.digest)).toEqual([
      "Nothing new has arrived since the last check.",
      "new mail in the inbox",
      "Nothing new has arrived since the last check.",
      "Nothing new has arrived since the last check.",
    ]);
    expect(h.seen[1].digest).not.toContain("freight");
    expect(h.seen.map((c) => c.simTimeLabel)).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    // The last tick knows it is the last.
    expect(h.seen.map((c) => c.ticksLeft)).toEqual([3, 2, 1, 0]);
  });

  it("shows the director what the agent did in the PREVIOUS tick, once", async () => {
    const h = harness();
    const deltas: number[] = [];
    h.director.react = (ctx) => {
      deltas.push(ctx.deltas.length);
      // The agent's row appears on tick 1 and never again.
      if (ctx.tick === 0) h.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1_500 }));
      return Promise.resolve([]);
    };
    await runEpisode(options(h));
    expect(deltas).toEqual([0, 1, 0, 0]);
  });
});

describe("the artifact", () => {
  it("has the shape every later reader depends on", async () => {
    const h = harness();
    h.nextSteps([toolStep(0)]);
    const { run, trace, preflight } = await runEpisode(options(h));

    expect(run).toMatchObject({
      runId: "run-1",
      specId: "ep-test",
      specTitle: "The unhappy client",
      model: "test/model",
      status: "done",
      verdict: null,
    });
    expect(run.endedAt).toBeGreaterThan(run.startedAt);
    expect(run.ticks).toHaveLength(4);
    expect(trace.runId).toBe("run-1");
    expect(preflight).toEqual([{ name: "gmail", ok: true }]);

    const record: TickRecord = run.ticks[1];
    expect(Object.keys(record).sort()).toEqual([
      "agentSteps",
      "beatsFired",
      "directorEvents",
      "endedAt",
      "notes",
      "simTimeISO",
      "startedAt",
      "tick",
    ]);
    expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.beatsFired[0]).toMatchObject({
      beatId: "b0",
      ref: "opener",
      twin: "gmail",
      kind: "email",
      handle: { twin: "gmail", id: "gmail-1" },
    });
  });

  it("carries both snapshots for each twin the episode uses, and no others", async () => {
    const h = harness();
    const { run } = await runEpisode(options(h));
    // Slack has an adapter but no beats and no criteria, so it is not in the run.
    expect(Object.keys(run.snapshots)).toEqual(["gmail"]);
    expect(run.snapshots.gmail?.before.twin).toBe("gmail");
    expect(run.snapshots.gmail?.after.twin).toBe("gmail");
  });

  it("resolves beat refs to the ids the twin minted", async () => {
    const h = harness();
    const { refs } = await runEpisode(options(h));
    expect(refs).toEqual({ opener: "gmail-1" });
  });

  it("credits the agent with the audit rows written during the run, and no earlier ones", async () => {
    const h = harness();
    // id 1 predates the run; id 2 lands inside it.
    h.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 0 }));
    h.director.react = (ctx) => {
      if (ctx.tick === 0) h.gmail.rows.push(auditRow({ id: 2, twin: "gmail", ts: 5_000 }));
      return Promise.resolve([]);
    };
    const { audit } = await runEpisode(options(h));
    expect(audit.map((r) => r.id)).toEqual([2]);
  });

  it("names authoring mistakes on tick 0", async () => {
    const h = harness();
    const bad = spec({
      beats: [
        beat({ id: "late", tick: 9 }),
        beat({ id: "cal", tick: 0, twin: "calendar", kind: "cancel", payload: { eventRef: "x" } }),
      ],
    });
    const { run } = await runEpisode(options(h, { spec: bad }));
    expect(run.ticks[0].notes[0]).toContain('beat "late" is scheduled for tick 9, outside the day');
    expect(run.ticks[0].notes[1]).toContain("no calendar adapter in this run");
  });

  it("records a beat that did not land, and carries on", async () => {
    const h = harness();
    h.gmail.failInject = "twin returned 500";
    const { run } = await runEpisode(options(h));
    expect(run.status).toBe("done");
    expect(run.ticks[1].beatsFired[0].error).toBe("twin returned 500");
    expect(run.ticks[1].notes).toContain("beat b0: twin returned 500");
  });

  it("reports a failed run rather than throwing it at the caller", async () => {
    const h = harness();
    const exploding: FakeAdapter = { ...h.gmail, reset: () => Promise.reject(new Error("twin is down")) };
    const { run } = await runEpisode(options(h, { adapters: [exploding], resetTwins: true }));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("twin is down");
    expect(run.endedAt).not.toBeNull();
  });
});

describe("termination", () => {
  it("stops early once the agent has been idle for the declared number of ticks", async () => {
    const h = harness();
    const idle = spec({
      beats: [],
      termination: { stopWhenAllMustPass: false, idleTicks: 2, maxWallClockMs: 0 },
    });
    const { run } = await runEpisode(options(h, { spec: idle }));
    expect(run.ticks).toHaveLength(2);
    expect(run.ticks[1].notes).toContain(
      "run stopped early: the agent did nothing for 2 consecutive interval(s)",
    );
  });

  it("does not count a tick in which the agent acted", async () => {
    const h = harness();
    const idle = spec({
      beats: [],
      termination: { stopWhenAllMustPass: false, idleTicks: 2, maxWallClockMs: 0 },
    });
    h.agent.act = (ctx) => Promise.resolve(ctx.tick === 1 ? [toolStep(0)] : []);
    const { run } = await runEpisode(options(h, { spec: idle }));
    // Idle at 0, reset at 1, idle at 2 and 3 — which is the whole day anyway.
    expect(run.ticks).toHaveLength(4);
  });

  it("honours maxTicks without extending the day", async () => {
    const h = harness();
    const short = spec({
      beats: [],
      termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 0, maxTicks: 2 },
    });
    expect((await runEpisode(options(h, { spec: short }))).run.ticks).toHaveLength(2);

    const long = spec({
      beats: [],
      termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 0, maxTicks: 99 },
    });
    expect((await runEpisode(options(h, { spec: long }))).run.ticks).toHaveLength(4);
  });

  it("stops when the caller's checklist says every must-pass criterion is met", async () => {
    const h = harness();
    const early = spec({
      beats: [],
      termination: { stopWhenAllMustPass: true, idleTicks: 0, maxWallClockMs: 0 },
    });
    const { run } = await runEpisode(
      options(h, { spec: early, allMustPass: (ticks) => ticks.length >= 2 }),
    );
    expect(run.ticks).toHaveLength(2);
    expect(run.ticks[1].notes).toContain("run stopped early: every must-pass criterion was met");
  });

  it("names each budget in the order it is checked", () => {
    const base = { ticks: [], idle: 0, elapsedMs: 0, costUsd: 0 };
    const s = (over: Parameters<typeof spec>[0]) => spec(over);

    expect(
      stopReason(s({ termination: { stopWhenAllMustPass: true, idleTicks: 0, maxWallClockMs: 0 } }), base, true),
    ).toMatch(/must-pass/);
    // Off unless the spec asks for it, even when the predicate says yes.
    expect(stopReason(s({}), base, true)).toBeUndefined();

    expect(
      stopReason(
        s({ termination: { stopWhenAllMustPass: false, idleTicks: 3, maxWallClockMs: 0 } }),
        { ...base, idle: 3 },
        false,
      ),
    ).toMatch(/did nothing for 3/);
    // idleTicks 0 means "never stop for idling", not "stop immediately".
    expect(stopReason(s({}), { ...base, idle: 9 }, false)).toBeUndefined();

    expect(
      stopReason(
        s({ termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 500 } }),
        { ...base, elapsedMs: 500 },
        false,
      ),
    ).toMatch(/wall-clock budget/);

    expect(
      stopReason(
        s({ termination: { stopWhenAllMustPass: false, idleTicks: 0, maxWallClockMs: 0, maxCostUsd: 0.5 } }),
        { ...base, costUsd: 0.51 },
        false,
      ),
    ).toMatch(/spend budget/);
  });

  it("counts a tool call or an escalation as acting, and a thought as not", () => {
    const record = (agentSteps: AgentStep[]): TickRecord => ({
      tick: 0,
      simTimeISO: "",
      startedAt: 0,
      endedAt: 0,
      beatsFired: [],
      directorEvents: [],
      agentSteps,
      notes: [],
    });
    expect(didSomething(record([]))).toBe(false);
    expect(didSomething(record([{ kind: "thought", seq: 0, at: 0, text: "hmm" }]))).toBe(false);
    expect(didSomething(record([toolStep(0)]))).toBe(true);
    expect(didSomething(record([{ kind: "escalation", seq: 0, at: 0, text: "help" }]))).toBe(true);
  });
});

describe("preflight", () => {
  it("uses only the twins the episode's beats and criteria name", () => {
    const gmail = fakeAdapter("gmail");
    const slack = fakeAdapter("slack");
    const calendar = fakeAdapter("calendar");
    const used = adaptersForSpec(
      spec({
        beats: [beat({ id: "b", tick: 0 })],
        success: {
          checklist: [
            { id: "c1", description: "told the team", twin: "slack", kind: "posted", weight: 1, severity: "must" },
            { id: "c2", description: "consistent", twin: "any", kind: "judged", weight: 1, severity: "should" },
          ],
          judgeQuestions: [],
        },
      }),
      [gmail, slack, calendar],
    );
    expect(Object.keys(used).sort()).toEqual(["gmail", "slack"]);
  });

  it("warns about beats that could never land", () => {
    const gmail = fakeAdapter("gmail");
    const warnings = specWarnings(
      spec({
        beats: [
          beat({ id: "late", tick: 4 }),
          beat({ id: "slack", tick: 0, twin: "slack", kind: "message", payload: { channel: "ops", from: "sam", text: "hi" } }),
        ],
      }),
      { gmail },
    );
    expect(warnings).toEqual([
      'beat "late" is scheduled for tick 4, outside the day',
      "no slack adapter in this run, so its beats cannot land",
    ]);
  });
});
