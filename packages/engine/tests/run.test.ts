import { describe, it, expect } from "vitest";
import type { AgentStep, DirectorEvent, DirectorPolicy, TickRecord, TwinName } from "@sonata/core";
import { autonomy } from "@sonata/judge/autonomy";
import {
  adaptersForSpec,
  didSomething,
  runEpisode,
  specWarnings,
  stopReason,
  type RunOptions,
} from "../src/run";
import type { Agent, AgentContext } from "../src/agent";
import { createDirector, type Director } from "../src/director";
import type { CompleteJSONOptions } from "../src/llm";
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

// ---------------------------------------------------------------------------
// The world reading the agent, end to end
//
// Two things the loop has to hand the director that the audit log cannot carry:
// what the agent WROTE (the log has "Sent \"Re: SLA\"" and no body), and WHICH
// STEP wrote it (so `becauseSeq` can be set). Both are asserted here through the
// real director rather than a stub, because both are lost the moment `boundEvents`
// is bypassed — which is how `becauseSeq` came to be declared, read in four
// places, and written by nothing.
// ---------------------------------------------------------------------------

/** A model seam that replies to whatever ref the prompt offered it. */
function replyingModel() {
  const prompts: string[] = [];
  const complete = async <T>(opts: CompleteJSONOptions): Promise<T> => {
    prompts.push(opts.prompt);
    const ref = /replyToRef "(act:[^"]+)"/.exec(opts.prompt)?.[1];
    return {
      events: ref
        ? [
            {
              surface: "gmail",
              kind: "email",
              reason: "she read the reply",
              subject: "Re: SLA",
              to: [],
              body: "That still does not tell me when.",
              channel: "",
              emoji: "",
              replyToRef: ref,
              eventRef: "",
              response: "",
            },
          ]
        : [],
    } as T;
  };
  return { complete, prompts };
}

/** The client, on the surfaces this test needs her, answering without waiting. */
function client(surfaces: TwinName[], replyDelayTicks = 0): DirectorPolicy {
  return {
    ...spec().director,
    personas: [{ personId: "dana", responsiveness: 0.8, replyDelayTicks, surfaces }],
  };
}

describe("the world reads what the agent wrote", () => {
  /** The agent sending an email: a step in the record, a row in the twin's log. */
  function sends(gmail: FakeAdapter, seq: number, id: number, body: string): AgentStep {
    gmail.rows.push(
      auditRow({ id, twin: "gmail", ts: 5_000, summary: 'Sent "Re: SLA" to dana@acme.test' }),
    );
    return {
      kind: "tool",
      seq,
      at: 5_000,
      twin: "gmail",
      name: "gmail_send",
      args: { body },
      resultSummary: "sent",
      isMutation: true,
    };
  }

  /** Acts on ticks 0 and 2, so the world has something to answer and time to answer it. */
  function replyingAgent(gmail: FakeAdapter): Agent {
    return {
      act: (c: AgentContext) => {
        if (c.tick === 0) return Promise.resolve([sends(gmail, 0, 1, "The £40k credit is approved.")]);
        if (c.tick === 2) return Promise.resolve([sends(gmail, 1, 2, "Thursday 2pm is booked.")]);
        return Promise.resolve([]);
      },
      wrapUp: () => Promise.resolve("done"),
    };
  }

  async function day(replyDelayTicks = 0) {
    const gmail = fakeAdapter("gmail");
    const model = replyingModel();
    // The client's opening email, so the day has a gmail twin in it and a reason
    // for the agent to write at all.
    const s = spec({
      beats: [beat({ id: "opener", tick: 0, ref: "opener" })],
      director: client(["gmail"], replyDelayTicks),
    });
    let clock = 1_000;
    const result = await runEpisode({
      spec: s,
      adapters: [gmail],
      agent: replyingAgent(gmail),
      director: createDirector({ spec: s, complete: model.complete }),
      model: "test/model",
      runId: "run-prose",
      now: () => (clock += 10),
    });
    return { result, prompts: model.prompts };
  }

  it("shows the client the body of the email, not just its subject line", async () => {
    const { prompts } = await day();
    // Two calls in the whole day, and both are Dana answering something she was
    // sent. Tick 0 buys none: the beat that opens the day is her own email, and
    // nobody reacts to themselves.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Sent "Re: SLA" to dana@acme.test');
    expect(prompts[0]).toContain("it wrote: “The £40k credit is approved.”");
    expect(prompts[1]).toContain("it wrote: “Thursday 2pm is booked.”");
  });

  it("still reaches a client who sits on her reply for a tick", async () => {
    // `replyDelayTicks` is mechanical now, so the tick that carries the agent's
    // words and the tick she answers on are different ticks. The words have to
    // survive the wait, or the people who wait are exactly the people who never
    // read the reply.
    const { result, prompts } = await day(1);
    expect(prompts[0]).toContain("it wrote: “The £40k credit is approved.”");
    expect(prompts[0]).toContain("still unanswered by you");
    const answered = result.run.ticks.flatMap((t) => t.directorEvents);
    expect(answered).toHaveLength(1);
    // And the causal arrow survives it too.
    expect(answered[0].becauseSeq).toBe(0);
  });

  it("sets becauseSeq to the step the world was answering", async () => {
    const { result } = await day();
    // The agent sent at tick 0 (step seq 0); the world answers at tick 1.
    const answer = result.run.ticks[1].directorEvents[0];
    expect(answer.personId).toBe("dana");
    expect(answer.becauseSeq).toBe(0);
    // And at tick 3 it answers the SECOND email, which is a different step.
    expect(result.run.ticks[3].directorEvents[0].becauseSeq).toBe(1);
  });

  // The number that has been silently zero on every real run. It only stays fixed
  // if something asserts it, so this asserts the judge's arithmetic and not the
  // engine's field: `exchanges` is 0 for any run where nothing writes `becauseSeq`.
  it("makes the autonomy score's exchanges non-zero, which it never was", async () => {
    const { result } = await day();
    const stats = autonomy([], result.run.ticks).stats;
    expect(stats.exchanges).toBeGreaterThan(0);
    // Tick 1's exchange, carried because the agent acted again at tick 2. Tick 3's
    // is excluded on purpose — it is the last tick, so the agent was never given
    // one in which to answer.
    expect(stats.exchanges).toBe(1);
    expect(stats.exchangesCarried).toBe(1);
    expect(result.run.ticks.map((t) => t.directorEvents.length)).toEqual([0, 1, 0, 1]);
  });

  it("buys no call at all on a tick where nobody has a reason to speak", async () => {
    // The agent is silent in tick 1 and the world has already answered, so tick 2
    // has nobody to call. Under one-call-for-everybody that tick still cost a
    // model call, every tick of every day, whatever was happening.
    const { result, prompts } = await day();
    expect(prompts).toHaveLength(2);
    expect(result.run.ticks[2].directorEvents).toEqual([]);
    expect(result.run.ticks[2].notes.join(" ")).toMatch(/nothing has happened since the last reaction/);
  });

  it("keeps each twin's body on its own row when their audit ids collide", async () => {
    // Every twin numbers its own `action_log` from 1, so the first interval in
    // which the agent both emails and posts to Slack yields gmail row 1 AND slack
    // row 1. If the two are indexed by the number alone, the client is shown the
    // Slack one-liner as the body of the email it is waiting on and escalates
    // about a figure it has already been given — this change's own bug, rebuilt.
    const gmail = fakeAdapter("gmail");
    const slack = fakeAdapter("slack");
    const model = replyingModel();
    const s = spec({
      beats: [
        beat({ id: "opener", tick: 0, ref: "opener" }),
        beat({
          id: "standup",
          tick: 0,
          twin: "slack",
          kind: "message",
          payload: { channel: "ops", from: "sam", text: "morning" },
        }),
      ],
      // On both surfaces, so one prompt holds both rows and the two can be
      // confused. A gmail-only client would simply never be shown the Slack one.
      director: client(["gmail", "slack"]),
    });
    const agent: Agent = {
      act: (c: AgentContext) => {
        if (c.tick !== 0) return Promise.resolve([]);
        const email = sends(gmail, 0, 1, "The £40k credit is approved.");
        slack.rows.push(auditRow({ id: 1, twin: "slack", ts: 5_000, summary: "Posted in #ops" }));
        const post: AgentStep = {
          kind: "tool",
          seq: 1,
          at: 5_000,
          twin: "slack",
          name: "slack_post",
          args: { text: "looking into it" },
          resultSummary: "posted",
          isMutation: true,
        };
        return Promise.resolve([email, post]);
      },
      wrapUp: () => Promise.resolve("done"),
    };
    let clock = 1_000;
    const result = await runEpisode({
      spec: s,
      adapters: [gmail, slack],
      agent,
      director: createDirector({ spec: s, complete: model.complete }),
      model: "test/model",
      runId: "run-collide",
      now: () => (clock += 10),
    });
    expect(result.run.status).toBe("done");

    const lines = model.prompts[0].split("\n");
    const under = (summary: string): string =>
      lines[lines.findIndex((l: string) => l.includes(summary)) + 1];
    expect(under('Sent "Re: SLA"')).toContain("The £40k credit is approved.");
    expect(under("Posted in #ops")).toContain("looking into it");
  });
});

// ---------------------------------------------------------------------------
// Adaptive beat wording, through the real loop.
//
// The bug: `ce-b10` fires at t12 saying "I've had nothing since nine o'clock"
// whether or not the agent answered at t2, and a 3-point `must` then grades the
// agent on its reply to that false accusation.
//
// The fix is not cancelling the beat. It fires at the same tick either way; only
// the sentence moves. Everything here is about the two halves of that: the beat
// still lands where the script put it, and the world has actually READ the run
// before it opens its mouth.
// ---------------------------------------------------------------------------

describe("a beat that adapts its wording", () => {
  const AUTHORED = "I've had nothing since nine o'clock. The £40k credit still stands.";
  const REWORDED = "Thanks — but that leaves the £40k credit unanswered, and I need a date.";

  /** A spec whose escalation at tick 2 adapts to whether the opener was answered. */
  function adaptiveSpec(adapt = true) {
    return spec({
      beats: [
        beat({ id: "opener", tick: 0, ref: "opener" }),
        beat({
          id: "esc",
          tick: 2,
          ref: "escalation",
          payload: { from: "dana", to: ["priya"], subject: "Where is my freight", body: AUTHORED },
          ...(adapt
            ? {
                adapt: {
                  when: {
                    description: "the assistant already answered the opening email",
                    twin: "gmail" as const,
                    kind: "replied" as const,
                    ref: "opener",
                  },
                  facts: ["£40k credit"],
                },
              }
            : {}),
        }),
      ],
      director: client(["gmail"]),
    });
  }

  /** A model seam that answers both schemas, and counts what it was asked for. */
  function worldModel(rewriteAs = REWORDED) {
    const rewrites: CompleteJSONOptions[] = [];
    const complete = async <T>(opts: CompleteJSONOptions): Promise<T> => {
      if (opts.schemaName === "beat_rewrite") {
        rewrites.push(opts);
        return { text: rewriteAs } as T;
      }
      return { events: [] } as T;
    };
    return { complete, rewrites };
  }

  /** The agent replying on the client's thread at `tick`, as the twin logs it. */
  function agentRepliesAt(gmail: FakeAdapter, tick: number): Agent {
    return {
      act: (c: AgentContext) => {
        if (c.tick !== tick) return Promise.resolve([]);
        gmail.rows.push(
          auditRow({
            id: 7,
            twin: "gmail",
            ts: 5_000,
            actionType: "send",
            targetId: "gmail-c",
            summary: 'Sent "Re: Where is my freight" to dana@acme.test',
          }),
        );
        return Promise.resolve([
          {
            kind: "tool",
            seq: 0,
            at: 5_000,
            twin: "gmail",
            name: "gmail_send",
            args: { body: "The £40k credit is approved, I will come back with a time." },
            resultSummary: "sent",
            isMutation: true,
          } satisfies AgentStep,
        ]);
      },
      wrapUp: () => Promise.resolve("done"),
    };
  }

  async function day(opts: { adapt?: boolean; repliesAt?: number; rewriteAs?: string } = {}) {
    const gmail = fakeAdapter("gmail");
    let snapshots = 0;
    let reads = 0;
    const realSnapshot = gmail.snapshot.bind(gmail);
    gmail.snapshot = () => {
      snapshots += 1;
      return realSnapshot();
    };
    const realAudit = gmail.auditSince.bind(gmail);
    gmail.auditSince = (since) => {
      reads += 1;
      return realAudit(since);
    };
    const model = worldModel(opts.rewriteAs ?? REWORDED);
    const s = adaptiveSpec(opts.adapt ?? true);
    let clock = 1_000;
    const result = await runEpisode({
      spec: s,
      adapters: [gmail],
      agent:
        opts.repliesAt === undefined
          ? { act: () => Promise.resolve([]), wrapUp: () => Promise.resolve("done") }
          : agentRepliesAt(gmail, opts.repliesAt),
      director: createDirector({ spec: s, complete: model.complete }),
      model: "test/model",
      runId: "run-adapt",
      now: () => (clock += 10),
    });
    const esc = result.run.ticks[2].beatsFired.find((b) => b.beatId === "esc");
    return { result, model, snapshots, reads, esc, gmail };
  }

  it("sees a reply sent in the PREVIOUS tick, which the loop's own order hides", async () => {
    // The whole point. This loop fires beats before it reads the audit log, so at
    // tick 2 it would otherwise know only what happened by tick 0 — and the beat
    // would accuse the agent of a silence it broke fifteen minutes earlier.
    const { result, model } = await day({ repliesAt: 1 });
    expect(model.rewrites).toHaveLength(1);
    expect(model.rewrites[0].prompt).toContain(AUTHORED);
    const note = result.run.ticks[2].notes.find((n) => n.startsWith("beat esc adapt:")) ?? "";
    expect(note).toContain("the agent has:");
    expect(note).toContain("Reworded in character as Dana Reyes");
  });

  it("fires at the same tick, with the same ref, in both branches", async () => {
    // The comparability property: the shape of the day is identical whatever the
    // agent did, so every criterion binds exactly as it does today.
    const answered = await day({ repliesAt: 1 });
    const ignored = await day({});

    for (const outcome of [answered, ignored]) {
      expect(outcome.result.run.ticks[2].beatsFired.map((b) => b.beatId)).toEqual(["esc"]);
      expect(outcome.esc?.ref).toBe("escalation");
      expect(outcome.esc?.handle?.twin).toBe("gmail");
      expect(outcome.esc?.error).toBeUndefined();
      expect(outcome.result.refs.escalation).toBeTruthy();
    }
    // Only the words differ, and the ignored branch reads exactly as it does today.
    const sent = (d: Awaited<ReturnType<typeof day>>) =>
      d.gmail.injected.filter((i) => i.kind === "email").length;
    expect(sent(answered)).toBe(sent(ignored));
    expect(ignored.model.rewrites).toHaveLength(0);
  });

  it("keeps the authored text when the rewrite drops a required fact", async () => {
    const { result, model } = await day({
      repliesAt: 1,
      rewriteAs: "Thanks, that is fine, I will wait.",
    });
    expect(model.rewrites).toHaveLength(1);
    const note = result.run.ticks[2].notes.find((n) => n.startsWith("beat esc adapt:")) ?? "";
    expect(note).toContain('dropped "£40k credit"');
    // And the beat still fired, with everything it was always going to say.
    expect(result.run.ticks[2].beatsFired[0].error).toBeUndefined();
  });

  it("costs nothing at all on a day with nothing marked adaptive", async () => {
    // The regression bar, and it is about reads as much as about model calls. The
    // early delta read that lets a beat see the tick just gone is bought per
    // ADAPTIVE TICK, not per tick: an unconditional one would add a round trip to
    // every twin on every tick of every scenario shipped today, for nothing.
    const plain = await day({ adapt: false, repliesAt: 1 });
    expect(plain.model.rewrites).toHaveLength(0);
    // The run's own `before` and `after`, and no third.
    expect(plain.snapshots).toBe(2);
    // The opening cursor read, one per tick, and the closing attribution read.
    expect(plain.reads).toBe(6);
    expect(plain.result.run.ticks.flatMap((t) => t.notes).filter((n) => n.includes("adapt:"))).toEqual([]);

    // The same day with one beat marked adaptive pays for exactly that one tick.
    const adaptive = await day({ repliesAt: 1 });
    expect(adaptive.reads).toBe(7);
    expect(adaptive.snapshots).toBe(3);
  });

  it("names an adaptive beat that could never adapt, before the run rather than after", async () => {
    const warnings = specWarnings(
      spec({
        beats: [
          beat({ id: "opener", tick: 0, ref: "opener" }),
          beat({
            id: "esc",
            tick: 1,
            payload: { from: "dana", to: ["priya"], subject: "s", body: "no numbers here" },
            adapt: {
              when: { description: "replied", twin: "gmail", kind: "replied", ref: "opener" },
              facts: ["£40k credit"],
            },
          }),
          beat({
            id: "react",
            tick: 1,
            twin: "slack",
            kind: "reaction",
            payload: { messageRef: "x", from: "sam", emoji: "eyes" },
            adapt: {
              when: { description: "replied", twin: "gmail", kind: "replied", ref: "opener" },
              facts: [],
            },
          }),
        ],
      }),
      { gmail: fakeAdapter("gmail"), slack: fakeAdapter("slack") },
    );
    expect(warnings[0]).toContain('beat "esc" requires "£40k credit" to survive a rewrite');
    expect(warnings[1]).toContain('beat "react" is marked adaptive, but a slack reaction carries no wording');
  });

  it("names a condition pointing at a beat nothing in the spec creates", async () => {
    // The third way an adaptive beat silently never adapts, and the only one with
    // nothing else watching it: `danglingRefs` in @sonata/core reads payloads and
    // criteria and never looks inside `adapt`. The checklist then refuses the
    // condition as a harness defect on every tick of every run, the beat fires as
    // authored forever, and that is indistinguishable from the feature working.
    const warnings = specWarnings(
      spec({
        beats: [
          beat({
            id: "esc",
            tick: 1,
            payload: { from: "dana", to: ["priya"], subject: "s", body: "the £40k credit stands" },
            adapt: {
              when: { description: "replied", twin: "gmail", kind: "replied", ref: "never-authored" },
              facts: ["£40k credit"],
            },
          }),
        ],
      }),
      { gmail: fakeAdapter("gmail") },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('beat "esc" adapts on beat ref "never-authored"');
    expect(warnings[0]).toContain("can never be settled");
  });

  it("names a phrase a criterion scores the agent on that only an adaptive beat says", async () => {
    // The one way a rewrite can still move the score. `mentions` asks whether the
    // agent wrote a phrase; the agent can only write one it was told; and the
    // fairness backstop cannot see the problem, because `runTruncation.shownText`
    // is built from the AUTHORED payloads and swears the phrase was shown whatever
    // actually went out.
    const risky = (facts: string[]) =>
      spec({
        beats: [
          beat({ id: "opener", tick: 0, ref: "opener" }),
          beat({
            id: "esc",
            tick: 1,
            payload: { from: "dana", to: ["priya"], subject: "s", body: "the £40k credit stands" },
            adapt: {
              when: { description: "replied", twin: "gmail", kind: "replied", ref: "opener" },
              facts,
            },
          }),
        ],
        success: {
          checklist: [
            {
              id: "c1",
              description: "the reply names the credit",
              twin: "any",
              kind: "mentions",
              expect: "£40k",
              weight: 3,
              severity: "must",
            },
          ],
          judgeQuestions: [],
        },
      });

    const exposed = specWarnings(risky([]), { gmail: fakeAdapter("gmail") });
    expect(exposed).toHaveLength(1);
    expect(exposed[0]).toContain('criterion "c1"');
    expect(exposed[0]).toContain("adapt.facts");

    // Declaring a fact that contains the phrase closes it: a rewrite that lost it
    // is discarded and the authored words go out instead.
    expect(specWarnings(risky(["the £40k credit"]), { gmail: fakeAdapter("gmail") })).toEqual([]);
  });

  it("does not take the day down when the world's writer throws", async () => {
    // The property that does not bend: the beat fires at its tick in every run.
    // An exception out of `Director.rewrite` used to leave `adaptBeats`, leave
    // `runTick`, and fail the whole episode — this beat and every beat scheduled
    // after it never fired, and every criterion bound to them lost its subject.
    const gmail = fakeAdapter("gmail");
    const s = adaptiveSpec();
    s.beats.push(beat({ id: "later", tick: 3, ref: "later" }));
    const result = await runEpisode({
      spec: s,
      adapters: [gmail],
      agent: agentRepliesAt(gmail, 1),
      director: {
        react: () => Promise.resolve([]),
        lastNote: () => undefined,
        rewrite: () => {
          throw new Error("the world's writer blew up");
        },
      },
      model: "test/model",
      runId: "run-rewrite-throws",
      now: (() => {
        let clock = 1_000;
        return () => (clock += 10);
      })(),
    });

    expect(result.run.status).toBe("done");
    expect(result.run.ticks).toHaveLength(4);
    expect(result.refs.escalation).toBeTruthy();
    expect(result.refs.later).toBeTruthy();
    const note = result.run.ticks[2].notes.find((n) => n.startsWith("beat esc adapt:")) ?? "";
    expect(note).toContain("adapting it failed outright");
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
