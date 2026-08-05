import { describe, it, expect } from "vitest";
import {
  agentToolCalls,
  runExecuted,
  type DirectorEvent,
  type TickRecord,
  type TwinAuditRow,
} from "@sonata/core";
import {
  createSession,
  realMsPerTick,
  simHoursPerRealMinute,
  stepsFromAudit,
  type Session,
  type SessionOptions,
  type SessionTimer,
} from "../src/session";
import { createSessionRegistry, realTimer, sessionDurationMs } from "../src/live";
import type { DirectorContext, Director } from "../src/director";
import { auditRow, beat, fakeAdapter, spec, type FakeAdapter } from "./fixtures";

// A SESSION: the same day, with the agent on the outside.
//
// Every test here is offline and on a hand-cranked clock. That is not just for
// speed: a session's entire subject is *when* things happen in real time, and a
// test that reached for `setTimeout` would be asserting the machine's scheduler
// rather than the engine's arithmetic.

// ---------------------------------------------------------------------------
// A wall clock nobody has to wait for
// ---------------------------------------------------------------------------

interface FakeTimer extends SessionTimer {
  advance(ms: number): void;
  readonly pending: number;
}

function fakeTimer(start = 1_000): FakeTimer {
  let clock = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => clock,
    schedule(ms, fn) {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = target;
    },
    get pending() {
      return timers.size;
    },
  };
}

/**
 * Drain the session's work queue. Repeated because a tick schedules the next one
 * from inside itself, so one settle only covers the tick that just ran.
 */
async function settle(session: Session): Promise<void> {
  for (let i = 0; i < 4; i++) await session.whenSettled();
}

async function step(session: Session, timer: FakeTimer, ms: number): Promise<void> {
  timer.advance(ms);
  await settle(session);
}

// ---------------------------------------------------------------------------
// The world the session runs in
// ---------------------------------------------------------------------------

/** A director that records what it was shown and answers with whatever is queued. */
function stubDirector(): Director & { seen: DirectorContext[]; next(e: DirectorEvent[]): void } {
  const seen: DirectorContext[] = [];
  let queued: DirectorEvent[] = [];
  return {
    seen,
    next(e) {
      queued = e;
    },
    react(ctx) {
      seen.push(ctx);
      const out = queued;
      queued = [];
      return Promise.resolve(out);
    },
    lastNote: () => undefined,
  };
}

/** One simulated hour a real minute: a 15-minute tick lands every 15 real seconds. */
const COMPRESSION = simHoursPerRealMinute(1);
const TICK_MS = 15_000;

interface World {
  gmail: FakeAdapter;
  director: ReturnType<typeof stubDirector>;
  timer: FakeTimer;
  session: Session;
  ticks: TickRecord[];
}

function world(over: Partial<SessionOptions> = {}): World {
  const gmail = fakeAdapter("gmail");
  const director = stubDirector();
  const timer = fakeTimer();
  const ticks: TickRecord[] = [];
  const session = createSession({
    spec: spec({ beats: [beat({ id: "b0", tick: 0, ref: "opener" }), beat({ id: "b2", tick: 2 })] }),
    adapters: [gmail],
    compression: COMPRESSION,
    timer,
    director,
    sessionId: "sess-1",
    onTick: (t) => ticks.push(t),
    ...over,
  });
  return { gmail, director, timer, session, ticks };
}

/** The external agent acting: a row appears in the twin's audit log, from nowhere. */
function externalAction(w: World, row: Partial<TwinAuditRow> & Pick<TwinAuditRow, "id">): void {
  w.gmail.rows.push(auditRow({ twin: "gmail", ...row }));
}

// ---------------------------------------------------------------------------

describe("compression", () => {
  it("turns a rate into a real tick length", () => {
    const clock = { startISO: "2026-08-04T09:00:00Z", ticks: 4, simMinutesPerTick: 15 };
    // One simulated hour a real minute: a quarter-hour tick every fifteen seconds.
    expect(realMsPerTick(clock, simHoursPerRealMinute(1))).toBe(15_000);
    // Four sim-hours a minute is four times as fast.
    expect(realMsPerTick(clock, simHoursPerRealMinute(4))).toBe(3_750);
    // Real time is real time.
    expect(realMsPerTick(clock, 1)).toBe(900_000);
    // A nonsense rate falls back to real time rather than dividing by zero.
    expect(realMsPerTick(clock, 0)).toBe(900_000);
    expect(realMsPerTick(clock, Number.NaN)).toBe(900_000);
    expect(sessionDurationMs({ ...spec(), clock }, simHoursPerRealMinute(1))).toBe(60_000);
  });
});

describe("the world runs on the wall clock", () => {
  it("fires each beat at its own simulated time, one real tick apart", async () => {
    const w = world();
    await w.session.start();

    // Tick 0 is the start of the day, so it has already happened.
    expect(w.gmail.injected).toEqual([{ kind: "email", atISO: "2026-08-04T09:00:00.000Z" }]);
    expect(w.session.status().tick).toBe(0);
    expect(w.session.status().nextTickAt).toBe(1_000 + TICK_MS);

    // Most of a tick is not a tick.
    await step(w.session, w.timer, TICK_MS - 1);
    expect(w.session.status().tick).toBe(0);

    await step(w.session, w.timer, 1);
    expect(w.session.status().tick).toBe(1);
    expect(w.gmail.injected).toHaveLength(1);

    await step(w.session, w.timer, TICK_MS);
    expect(w.session.status().tick).toBe(2);
    expect(w.gmail.injected).toEqual([
      { kind: "email", atISO: "2026-08-04T09:00:00.000Z" },
      { kind: "email", atISO: "2026-08-04T09:30:00.000Z" },
    ]);

    const record = await w.session.stop();
    expect(record.run.ticks.map((t) => t.simTimeISO)).toEqual([
      "2026-08-04T09:00:00.000Z",
      "2026-08-04T09:15:00.000Z",
      "2026-08-04T09:30:00.000Z",
    ]);
  });

  it("dates the day from the start, so a slow tick cannot make the world drift", async () => {
    const w = world();
    await w.session.start();
    // Twelve seconds late to tick 1; tick 2 is still due on the original grid.
    await step(w.session, w.timer, TICK_MS + 12_000);
    expect(w.session.status().tick).toBe(1);
    expect(w.session.status().nextTickAt).toBe(1_000 + 2 * TICK_MS);
    await w.session.stop();
  });

  it("ends the day of its own accord once the clock runs out", async () => {
    const w = world();
    await w.session.start();
    for (let i = 0; i < 3; i++) await step(w.session, w.timer, TICK_MS);

    const record = await w.session.finished();
    expect(record.run.status).toBe("done");
    expect(record.endedBecause).toBe("the simulated day ended");
    expect(record.run.ticks).toHaveLength(4);
    expect(record.run.endedAt).not.toBeNull();
    // Nothing left ticking.
    expect(w.timer.pending).toBe(0);
  });
});

describe("the director reacts to an agent it never called", () => {
  it("is shown the audit delta an external actor left behind", async () => {
    const w = world();
    await w.session.start();
    expect(w.director.seen[0].deltas).toEqual([]);

    // The agent — running in its own process, on its own schedule — replies.
    externalAction(w, { id: 10, ts: 5_000, actionType: "send", targetId: "m-10", summary: "replied to Dana" });
    await step(w.session, w.timer, TICK_MS);

    expect(w.director.seen[1].deltas.map((d) => d.summary)).toEqual(["replied to Dana"]);
    // And exactly once: a delta re-read would have the world answer twice.
    await step(w.session, w.timer, TICK_MS);
    expect(w.director.seen[2].deltas).toEqual([]);
    await w.session.stop();
  });

  it("offers the world a ref for what the agent did, so a reply can attach to it", async () => {
    const w = world();
    await w.session.start();
    externalAction(w, { id: 10, ts: 5_000, targetId: "m-10", summary: "emailed the client" });

    // The director answers the thing the agent just created, by the ref name its
    // own prompt hands the model.
    w.director.next([
      {
        id: "dir-1-0",
        personId: "dana",
        reason: "answering",
        twin: "gmail",
        kind: "email",
        payload: { from: "dana", to: ["priya"], subject: "Re", body: "ok", inReplyTo: "act:gmail:10" },
      },
    ]);
    await step(w.session, w.timer, TICK_MS);

    const record = await w.session.stop();
    expect(record.refs["act:gmail:10"]).toBe("m-10");
    expect(record.run.ticks[1].directorEvents[0].handle).toEqual({
      twin: "gmail",
      id: "gmail-2",
      containerId: "gmail-c",
    });
  });

  it("reads what the agent did before firing this tick's beats", async () => {
    const w = world();
    // A beat that (impossibly) leaves an audit row: proof the delta was already
    // taken, so nothing the world does can be credited to the agent in the same
    // tick and make it look precognitive.
    const inject = w.gmail.inject.bind(w.gmail);
    w.gmail.inject = async (body, ctx) => {
      const handle = await inject(body, ctx);
      w.gmail.rows.push(auditRow({ id: 100 + w.gmail.rows.length, twin: "gmail", ts: 1 }));
      return handle;
    };

    await w.session.start();
    expect(w.session.status().agentActions).toBe(0);

    await step(w.session, w.timer, TICK_MS);
    expect(w.session.status().agentActions).toBe(1);
    await w.session.stop();
  });

  it("keeps the day going when a twin cannot be read", async () => {
    const w = world();
    await w.session.start();
    w.gmail.auditSince = () => Promise.reject(new Error("twin is down"));
    await step(w.session, w.timer, TICK_MS);
    expect(w.session.status().status).toBe("running");
    expect(w.session.status().tick).toBe(1);
    await w.session.stop();
  });
});

describe("the record the judge already knows how to read", () => {
  it("is an EpisodeRun with ticks in the shape every later reader depends on", async () => {
    const w = world();
    await w.session.start();
    externalAction(w, { id: 10, ts: 5_000, method: "POST", actionType: "send", targetId: "m-10" });
    await step(w.session, w.timer, TICK_MS);
    for (let i = 0; i < 2; i++) await step(w.session, w.timer, TICK_MS);
    const record = await w.session.finished();

    expect(record.run).toMatchObject({
      runId: "sess-1",
      specId: "ep-test",
      specTitle: "The unhappy client",
      model: "external agent",
      status: "done",
      verdict: null,
    });
    expect(Object.keys(record.run.ticks[1]).sort()).toEqual([
      "agentSteps",
      "beatsFired",
      "directorEvents",
      "endedAt",
      "notes",
      "simTimeISO",
      "startedAt",
      "tick",
    ]);
    // Both snapshots, so the checklist can be run and the diff drawn.
    expect(record.run.snapshots.gmail?.before.twin).toBe("gmail");
    expect(record.run.snapshots.gmail?.after.twin).toBe("gmail");
    expect(record.refs).toEqual({ opener: "gmail-1", "act:gmail:10": "m-10" });
    expect(record.audit.map((r) => r.id)).toEqual([10]);
    expect(record.preflight).toEqual([{ name: "gmail", ok: true }]);

    // The gate the platform puts in front of every score: a session passes it on
    // exactly the same evidence a scored episode does — tool calls on the record.
    expect(agentToolCalls(record.run.ticks)).toBe(1);
    expect(runExecuted(record.run)).toBe(true);
  });

  it("says out loud what an external agent's record cannot carry", async () => {
    const w = world();
    await w.session.start();
    externalAction(w, { id: 10, ts: 5_000, summary: "sent a reply" });
    await step(w.session, w.timer, TICK_MS);
    const record = await w.session.stop();

    // No reasoning is invented for an agent whose turns happened elsewhere.
    const kinds = record.run.ticks.flatMap((t) => t.agentSteps.map((s) => s.kind));
    expect(kinds).not.toContain("thought");
    expect(record.caveats.join(" ")).toMatch(/reasoning/);
    expect(record.caveats.join(" ")).toMatch(/request body/);
  });

  it("counts the world's own audit rows as nobody's work", async () => {
    const w = world();
    // Seeding left rows behind; they predate the session and are not the agent's.
    w.gmail.rows.push(auditRow({ id: 1, twin: "gmail" }), auditRow({ id: 2, twin: "gmail" }));
    await w.session.start();
    await step(w.session, w.timer, TICK_MS);
    const record = await w.session.stop();
    expect(record.audit).toEqual([]);
    expect(agentToolCalls(record.run.ticks)).toBe(0);
  });

  it("names authoring mistakes on tick 0, like a scored episode", async () => {
    const w = world({
      spec: spec({
        beats: [beat({ id: "late", tick: 9 })],
      }),
    });
    await w.session.start();
    expect(w.session.status().notes[0]).toContain(
      'beat "late" is scheduled for tick 9, outside the day',
    );
    await w.session.stop();
  });
});

describe("what the agent did, read out of the world", () => {
  it("turns audit rows into tool steps without inventing arguments", () => {
    const steps = stepsFromAudit(
      [
        auditRow({ id: 7, twin: "gmail", ts: 42, method: "POST", actionType: "send", targetId: "m-7", summary: "sent a reply" }),
        auditRow({ id: 8, twin: "slack", ts: 43, method: "GET", actionType: null, endpoint: "/api/x", targetId: null, summary: "read" }),
      ],
      3,
    );
    expect(steps[0]).toEqual({
      kind: "tool",
      seq: 3,
      at: 42,
      twin: "gmail",
      name: "send",
      args: { method: "POST", endpoint: "/x", targetType: "message", targetId: "m-7" },
      resultSummary: "sent a reply",
      isMutation: true,
    });
    // No actionType: the row still names itself by the request it was.
    expect(steps[1]).toMatchObject({ seq: 4, name: "GET /api/x", isMutation: false });
    // The prose the agent wrote is not in the audit log, so it is not in the step.
    expect(JSON.stringify(steps)).not.toContain("body");
  });

  it("attributes an action to the tick that observed it", async () => {
    const w = world();
    await w.session.start();
    expect(w.ticks[0].agentSteps).toEqual([]);

    externalAction(w, { id: 10, ts: 5_000, summary: "archived the thread" });
    await step(w.session, w.timer, TICK_MS);
    expect(w.ticks[1].agentSteps).toHaveLength(1);
    expect(w.ticks[1].agentSteps[0]).toMatchObject({ kind: "tool", twin: "gmail" });
    await w.session.stop();
  });

  it("gives each tick the wall-clock window it observed, so the judge can place an action", async () => {
    const w = world();
    await w.session.start();
    // The agent acts in the gap between two ticks, which is the only place an
    // external agent ever acts.
    externalAction(w, { id: 10, ts: 1_000 + 7_000, summary: "replied" });
    await step(w.session, w.timer, TICK_MS);
    const record = await w.session.stop();

    // @sonata/judge's `tickIndexer`, in one line: a step's instant has to fall
    // inside the tick that reported it, or every criterion loses its tick.
    const placed = (ts: number) =>
      record.run.ticks.find((t) => ts >= t.startedAt && ts <= t.endedAt)?.tick;
    const step0 = record.run.ticks[1].agentSteps[0];
    expect(placed(step0.at)).toBe(1);
    // And the windows tile the day rather than leaving gaps between them.
    expect(record.run.ticks[0].endedAt).toBe(record.run.ticks[1].startedAt);
  });

  it("records a hand-back the harness reported, since no twin can log one", async () => {
    const w = world();
    await w.session.start();
    w.session.escalate("I cannot refund without approval");
    await step(w.session, w.timer, TICK_MS);

    expect(w.ticks[1].agentSteps).toEqual([
      { kind: "escalation", seq: 0, at: 1_000 + TICK_MS, text: "I cannot refund without approval" },
    ]);

    // One reported after the last tick still belongs to the day.
    w.session.escalate("and this one too");
    const record = await w.session.stop();
    const last = record.run.ticks[record.run.ticks.length - 1];
    expect(last.agentSteps.some((s) => s.kind === "escalation" && s.text === "and this one too")).toBe(true);
  });
});

describe("idleness is signal, not an error", () => {
  it("records a silent stretch and keeps the day running", async () => {
    const w = world({ idleTicks: 2 });
    await w.session.start();
    for (let i = 0; i < 3; i++) await step(w.session, w.timer, TICK_MS);
    const record = await w.session.finished();

    // Recorded once, when the streak crosses the line — not on every tick after.
    const noted = record.run.ticks.filter((t) =>
      t.notes.some((n) => n.includes("has done nothing for")),
    );
    expect(noted.map((t) => t.tick)).toEqual([1]);
    expect(noted[0].notes).toContain("the agent has done nothing for 2 consecutive interval(s)");
    // And the day ran to the end regardless: a session never stops for silence.
    expect(record.run.ticks).toHaveLength(4);
    expect(record.run.status).toBe("done");
  });

  it("notes when the agent finally shows up", async () => {
    const w = world({ idleTicks: 2 });
    await w.session.start();
    await step(w.session, w.timer, TICK_MS);
    await step(w.session, w.timer, TICK_MS);
    expect(w.session.status().idleStreak).toBe(3);

    externalAction(w, { id: 10, ts: 5_000, summary: "finally replied" });
    await step(w.session, w.timer, TICK_MS);

    expect(w.ticks[3].notes).toContain("the agent acted again after 3 silent interval(s)");
    expect(w.session.status().idleStreak).toBe(0);
    expect(w.session.status().longestIdleStreak).toBe(3);
    await w.session.finished();
  });

  it("says nothing about idleness when the spec did not ask", async () => {
    const w = world();
    await w.session.start();
    for (let i = 0; i < 3; i++) await step(w.session, w.timer, TICK_MS);
    const record = await w.session.finished();
    expect(record.run.ticks.flatMap((t) => t.notes)).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("reports where the day has got to", async () => {
    const w = world();
    expect(w.session.status()).toMatchObject({
      sessionId: "sess-1",
      status: "queued",
      tick: -1,
      ticks: 4,
      startedAt: null,
      endedAt: null,
    });

    await w.session.start();
    externalAction(w, { id: 10, ts: 5_000, summary: "replied to Dana" });
    await step(w.session, w.timer, TICK_MS);

    const state = w.session.status();
    expect(state).toMatchObject({
      status: "running",
      tick: 1,
      simTimeISO: "2026-08-04T09:15:00.000Z",
      simTimeLabel: "09:15",
      startedAt: 1_000,
      endedAt: null,
      nextTickAt: 1_000 + 2 * TICK_MS,
      beatsFired: 1,
      agentActions: 1,
    });
    // What has fired and what the agent has done, in the order it happened.
    expect(state.recent.map((r) => `${r.source}:${r.text}`)).toEqual([
      'world:Dana Reyes emailed Priya Raman: "Where is my freight"',
      "agent:send → replied to Dana",
    ]);
    expect(w.session.status(0).recent).toEqual([]);
    await w.session.stop();
  });

  it("stops cleanly: nothing scheduled, nothing half-written, the same record twice", async () => {
    const w = world();
    await w.session.start();
    await step(w.session, w.timer, TICK_MS);

    const record = await w.session.stop("the operator stopped it");
    expect(record.run.status).toBe("aborted");
    expect(record.endedBecause).toBe("the operator stopped it");
    expect(record.run.endedAt).toBe(1_000 + TICK_MS);
    expect(record.run.ticks).toHaveLength(2);
    expect(w.timer.pending).toBe(0);

    // The world really has stopped: more real time buys no more ticks.
    await step(w.session, w.timer, 10 * TICK_MS);
    expect(record.run.ticks).toHaveLength(2);

    // Stopping twice is the same day, not a second one.
    expect(await w.session.stop()).toBe(record);
    expect(await w.session.finished()).toBe(record);
  });

  it("reports a session that could not start rather than throwing it at the caller", async () => {
    const gmail = fakeAdapter("gmail");
    const broken: FakeAdapter = { ...gmail, seed: () => Promise.reject(new Error("twin is down")) };
    const timer = fakeTimer();
    const session = createSession({
      spec: spec({ beats: [beat({ id: "b0", tick: 0 })] }),
      adapters: [broken],
      compression: COMPRESSION,
      timer,
      director: stubDirector(),
      seedWorld: true,
    });

    await session.start();
    const record = await session.finished();
    expect(record.run.status).toBe("failed");
    expect(record.run.error).toBe("twin is down");
    expect(record.run.ticks).toEqual([]);
    expect(timer.pending).toBe(0);
  });

  it("ignores a second start", async () => {
    const w = world();
    await w.session.start();
    await w.session.start();
    expect(w.session.status().tick).toBe(0);
    expect(w.gmail.injected).toHaveLength(1);
    await w.session.stop();
  });
});

describe("the registry", () => {
  it("finds a running day again by id, and forgets it once it has ended", async () => {
    const registry = createSessionRegistry();
    const w = world();
    registry.add(w.session);
    await w.session.start();

    expect(registry.get("sess-1")).toBe(w.session);
    expect(registry.list().map((s) => s.sessionId)).toEqual(["sess-1"]);

    const record = await registry.stop("sess-1", "shutting down");
    expect(record?.run.status).toBe("aborted");
    expect(registry.get("sess-1")).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(await registry.stop("nope")).toBeUndefined();
  });

  it("drops a day that ended on its own", async () => {
    const registry = createSessionRegistry();
    const w = world();
    registry.add(w.session);
    await w.session.start();
    for (let i = 0; i < 3; i++) await step(w.session, w.timer, TICK_MS);
    await w.session.finished();
    // The `finished` handler runs on a microtask after the record is handed out.
    await Promise.resolve();
    expect(registry.get("sess-1")).toBeUndefined();
  });
});

describe("real time", () => {
  it("schedules on setTimeout and cancels what it scheduled", async () => {
    const timer = realTimer();
    const fired: number[] = [];
    const cancel = timer.schedule(1, () => fired.push(1));
    cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toEqual([]);
    expect(timer.now()).toBeGreaterThan(0);
  });
});
