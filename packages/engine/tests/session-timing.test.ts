import { describe, expect, it } from "vitest";
import type { DirectorEvent } from "@sonata/core";
import { createSession, type SessionOptions, type SessionTimer } from "../src/session";
import type { DirectorContext } from "../src/director";
import { auditRow, beat, fakeAdapter, spec } from "./fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(over: Partial<SessionOptions> = {}) {
  let now = 1000;
  let scheduled = 0;
  const timer: SessionTimer = { now: () => now, schedule: () => { scheduled++; return () => {}; } };
  const gmail = fakeAdapter("gmail");
  const seen: DirectorContext[] = [];
  const session = createSession({
    spec: spec({ beats: [beat({ id: "owner-note", tick: 0,
      payload: { from: "priya", to: ["dana"], subject: "Opening note", body: "Already sent" } })] }),
    adapters: [gmail], compression: 60, timer,
    timing: { policy: "provider-operations-v1", workUnitsPerTick: 12 },
    director: { react: async context => { seen.push(context); return []; }, lastNote: () => undefined },
    ...over,
  });
  return { session, gmail, seen, advanceReal(ms: number) { now += ms; }, scheduled: () => scheduled };
}

describe("provider operation timing", () => {
  it("charges reads and unsuccessful requests without advancing for provider latency", async () => {
    const f = fixture();
    await f.session.start();
    expect(f.scheduled()).toBe(0);
    await f.session.beginAction({ actionId: "read", operation: "gmail list", workUnits: 1 });
    f.advanceReal(120_000);
    await f.session.completeAction("read");
    await f.session.beginAction({ actionId: "rejected-by-app", operation: "gmail send", workUnits: 2 });
    await f.session.completeAction("rejected-by-app");
    expect(f.session.status()).toMatchObject({ tick: 0, simTimeISO: "2026-08-04T09:03:45.000Z", nextTickAt: null });
    const record = await f.session.stop();
    expect(record.run.actionLedger?.map(a => [a.actionId, a.workUnits, a.state])).toEqual([
      ["read", 1, "completed"], ["rejected-by-app", 2, "completed"],
    ]);
    expect(record.audit).toEqual([]);
  });

  it("fires boundary events before admitting a completion at that boundary", async () => {
    const f = fixture({ spec: spec({ beats: [beat({ id: "due", tick: 1 })] }) });
    await f.session.start();
    const admitted = await f.session.beginAction({ actionId: "boundary", operation: "send", workUnits: 12 });
    expect(admitted).toMatchObject({ accepted: true, completionTick: 1, simTimeISO: "2026-08-04T09:15:00.000Z" });
    expect(f.gmail.injected).toEqual([{ kind: "email", atISO: "2026-08-04T09:15:00.000Z" }]);
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("boundary");
    const record = await f.session.stop();
    expect(record.audit[0].logicalTime).toEqual({ actionId: "boundary", tick: 1, simTimeISO: admitted.simTimeISO });
    expect(record.run.ticks[0].agentSteps).toEqual([]);
    expect(record.run.ticks[1].agentSteps).toHaveLength(1);
  });

  it("returns an end-of-day rejection before the gateway capture acknowledgement", async () => {
    const capture = deferred();
    const f = fixture({ beforeCapture: () => capture.promise });
    await f.session.start();
    const decision = await f.session.beginAction({ actionId: "too-late", operation: "write", workUnits: 48 });
    expect(decision).toMatchObject({ accepted: false, completionTick: 4, simTimeISO: "2026-08-04T10:00:00.000Z" });
    expect((await f.session.beginAction({ actionId: "after-close", operation: "write", workUnits: 1 })).accepted).toBe(false);
    capture.resolve();
    const record = await f.session.finished();
    expect(record.run.status).toBe("done");
    expect(record.run.ticks.map(t => t.tick)).toEqual([0, 1, 2, 3]);
    expect(record.run.actionLedger).toMatchObject([{ actionId: "too-late", state: "rejected" }]);
    expect(record.audit).toEqual([]);
  });

  it("serializes admissions, refuses reused IDs, and captures completion once", async () => {
    const f = fixture();
    await f.session.start();
    const [first, concurrent] = await Promise.all([
      f.session.beginAction({ actionId: "first", operation: "write", workUnits: 2 }),
      f.session.beginAction({ actionId: "concurrent", operation: "read", workUnits: 1 }),
    ]);
    expect([first.accepted, concurrent.accepted]).toEqual([true, false]);
    await expect(f.session.waitForUpdate({ afterNotification: 0 })).rejects.toThrow("Complete");
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await Promise.all([f.session.completeAction("first"), f.session.completeAction("first")]);
    expect((await f.session.beginAction({ actionId: "first", operation: "write", workUnits: 2 })).accepted).toBe(false);
    expect(f.session.status().simTimeISO).toBe("2026-08-04T09:02:30.000Z");
    const record = await f.session.finishWork();
    expect(record.audit).toHaveLength(1);
    expect(record.run.ticks.flatMap(t => t.agentSteps)).toHaveLength(1);
    expect(f.seen.filter(context => context.deltas.length)).toHaveLength(1);
    expect(f.seen[1].deltaDetail?.get("gmail:1")).toEqual({ seq: 0 });
  });

  it("withholds app-supplied logical attribution and records uncertain capture explicitly", async () => {
    const f = fixture();
    await f.session.start();
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", logicalTime: { actionId: "forged", tick: 0, simTimeISO: "fake" } }));
    const record = await f.session.finishWork();
    expect(record.audit[0].logicalTime).toBeNull();
    expect(record.run.ticks.flatMap(t => t.notes).join(" ")).toContain("logical deadline attribution is unknown");
  });
});

describe("observable waiting", () => {
  it("processes a private event without waking, then wakes for an owner-visible arrival", async () => {
    const f = fixture({ spec: spec({ beats: [
      beat({ id: "private", tick: 1, payload: { from: "dana", to: ["sam"], subject: "private", body: "not for the owner" } }),
      beat({ id: "public", tick: 2 }),
    ] }) });
    await f.session.start();
    const wake = await f.session.waitForUpdate({ afterNotification: 0 });
    expect(wake).toEqual({ reason: "notification", notificationSequence: 1 });
    expect(f.session.status().tick).toBe(2);
    expect(f.seen.map(context => context.tick)).toEqual([0, 1, 2]);
    expect(f.gmail.injected).toHaveLength(2);
    await f.session.stop();
  });

  it("does not lose notifications delivered during an action's reserved duration", async () => {
    const f = fixture({ spec: spec({ beats: [beat({ id: "arrival", tick: 1 })] }) });
    await f.session.start();
    await f.session.beginAction({ actionId: "long-read", operation: "read", workUnits: 13 });
    await f.session.completeAction("long-read");
    expect(await f.session.waitForUpdate({ afterNotification: 0 })).toEqual({ reason: "notification", notificationSequence: 1 });
    expect(f.session.status().simTimeISO).toBe("2026-08-04T09:16:15.000Z");
    expect(await f.session.waitForUpdate({ afterNotification: 1, untilTick: 2 })).toEqual({ reason: "timer", notificationSequence: 1 });
    await f.session.stop();
  });

  it("uses explicit timer wakes and does not notify on owner-authored or failed messages", async () => {
    const f = fixture({ spec: spec({ beats: [
      beat({ id: "owner", tick: 1, payload: { from: "priya", to: ["dana"], subject: "outgoing", body: "sent" } }),
      beat({ id: "failed", tick: 2 }),
    ] }) });
    await f.session.start();
    expect(await f.session.waitForUpdate({ afterNotification: 0, untilTick: 1 })).toEqual({ reason: "timer", notificationSequence: 0 });
    f.gmail.failInject = "injection failed";
    expect(await f.session.waitForUpdate({ afterNotification: 0, untilTick: 3 })).toEqual({ reason: "timer", notificationSequence: 0 });
    expect(await f.session.waitForUpdate({ afterNotification: 0 })).toEqual({ reason: "day-ended", notificationSequence: 0 });
  });

  it("offers completed actions to the director once and wakes for its delivered response", async () => {
    const seen: DirectorContext[] = [];
    const reply: DirectorEvent = { twin: "gmail", kind: "email", id: "reply", personId: "dana", reason: "answer",
      payload: { from: "dana", to: ["priya"], subject: "answer", body: "Here it is" } };
    const f = fixture({ director: {
      react: async context => { seen.push(context); return context.tick === 2 ? [reply] : []; }, lastNote: () => undefined,
    } });
    await f.session.start();
    await f.session.beginAction({ actionId: "request", operation: "send", workUnits: 2 });
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("request");
    expect(await f.session.waitForUpdate({ afterNotification: 0 })).toEqual({ reason: "notification", notificationSequence: 1 });
    expect(seen.map(context => context.deltas.length)).toEqual([0, 1, 0]);
    expect(seen[1].deltas[0].logicalTime?.tick).toBe(0);
    await f.session.finishWork();
  });
});

describe("terminal action barrier", () => {
  it("closes admission immediately, drains the last mutation, then captures snapshots", async () => {
    const drained = deferred();
    const f = fixture({ beforeCapture: () => drained.promise });
    let snapshots = 0;
    const snapshot = f.gmail.snapshot;
    f.gmail.snapshot = async () => { snapshots++; return snapshot(); };
    await f.session.start();
    await f.session.beginAction({ actionId: "in-flight", operation: "write", workUnits: 2 });
    const stopped = f.session.stop();
    expect((await f.session.beginAction({ actionId: "too-late", operation: "write", workUnits: 2 })).accepted).toBe(false);
    expect(snapshots).toBe(1);
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("in-flight");
    drained.resolve();
    const record = await stopped;
    expect(snapshots).toBe(2);
    expect(record.audit).toMatchObject([{ id: 1, logicalTime: { actionId: "in-flight", tick: 0 } }]);
    expect(record.run.status).toBe("aborted");
  });

  it("does not take final snapshots after a failed external drain", async () => {
    const f = fixture({ beforeCapture: async () => { throw new Error("gateway did not drain"); } });
    await f.session.start();
    const record = await f.session.finalize({ status: "failed", error: "provider failed" });
    expect(record.run).toMatchObject({ status: "failed", verdict: null, snapshots: {} });
    expect(record.run.error).toContain("provider failed");
    expect(record.run.error).toContain("gateway did not drain");
  });

  it("cancels admission while a due world turn is in flight", async () => {
    const entered = deferred();
    const release = deferred();
    const f = fixture({ director: { react: async context => {
      if (context.tick === 1) { entered.resolve(); await release.promise; }
      return [];
    }, lastNote: () => undefined } });
    await f.session.start();
    const admission = f.session.beginAction({ actionId: "cancelled", operation: "write", workUnits: 12 });
    await entered.promise;
    const stopped = f.session.stop();
    release.resolve();
    expect((await admission).accepted).toBe(false);
    expect((await stopped).run.status).toBe("aborted");
  });

  it("finishing work drains an admitted request and processes every remaining interval", async () => {
    const f = fixture({ spec: spec({ beats: [beat({ id: "late", tick: 3 })] }) });
    await f.session.start();
    await f.session.beginAction({ actionId: "last", operation: "write", workUnits: 2 });
    const finished = f.session.finishWork();
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("last");
    const record = await finished;
    expect(record.run.ticks.map(t => t.tick)).toEqual([0, 1, 2, 3]);
    expect(record.run.status).toBe("done");
    expect(record.audit).toHaveLength(1);
    expect(f.gmail.injected).toHaveLength(1);
    expect(f.session.status().simTimeISO).toBe("2026-08-04T10:00:00.000Z");
  });
});

describe("competing work and attempt charges", () => {
  it("processes a competing case during a wait and honours the earlier agent-set wake", async () => {
    const f = fixture({ spec: spec({ beats: [
      beat({ id: "case-b-closes", tick: 1, payload: { from: "dana", to: ["sam"], subject: "Case B closed", body: "Filed without her" } }),
      beat({ id: "case-a-reply", tick: 3 }),
    ] }) });
    await f.session.start();
    // The agent waits for Case A, whose reply is two intervals past its own wake.
    expect(await f.session.waitForUpdate({ afterNotification: 0, untilTick: 2 })).toEqual({ reason: "timer", notificationSequence: 0 });
    expect(f.session.status().tick).toBe(2);
    // Case B still closed while it waited, and waiting produced no reminder about it.
    expect(f.seen.map(context => context.tick)).toEqual([0, 1, 2]);
    expect(f.gmail.injected).toEqual([{ kind: "email", atISO: "2026-08-04T09:15:00.000Z" }]);
    expect(await f.session.waitForUpdate({ afterNotification: 0 })).toEqual({ reason: "notification", notificationSequence: 1 });
    expect(f.session.status().tick).toBe(3);
    await f.session.stop();
  });

  it("charges a refused attempt once and charges the agent's fresh retry again", async () => {
    const f = fixture();
    await f.session.start();
    // The app rejected this one, so it leaves no audit row — but it consumed its charge.
    await f.session.beginAction({ actionId: "bad-recipient", operation: "gmail send", workUnits: 2 });
    await f.session.completeAction("bad-recipient");
    const replayed = await f.session.beginAction({ actionId: "bad-recipient", operation: "gmail send", workUnits: 2 });
    expect(replayed).toMatchObject({ accepted: false, reason: "actionId has already been used" });
    const retry = await f.session.beginAction({ actionId: "corrected-recipient", operation: "gmail send", workUnits: 2 });
    expect(retry).toMatchObject({ accepted: true, simTimeISO: "2026-08-04T09:05:00.000Z" });
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("corrected-recipient");
    const record = await f.session.finishWork();
    // A transport replay of the same reservation is free; a new attempt is not.
    expect(record.run.actionLedger?.map(a => [a.actionId, a.workUnits, a.completionWorkUnits])).toEqual([
      ["bad-recipient", 2, 2], ["corrected-recipient", 2, 4],
    ]);
    expect(record.audit).toMatchObject([{ id: 1, logicalTime: { actionId: "corrected-recipient", simTimeISO: "2026-08-04T09:05:00.000Z" } }]);
  });

  it("keeps a resource guard's own stop reason instead of reporting a finished day", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.beginAction({ actionId: "saved-work", operation: "gmail send", workUnits: 2 });
    f.gmail.rows.push(auditRow({ id: 1, twin: "gmail", ts: 1000 }));
    await f.session.completeAction("saved-work");
    const guard = "Declared wall-clock budget exhausted; this is a partial evaluation.";
    const record = await f.session.finalize({ status: "failed", reason: guard, error: guard });
    expect(record.run.status).toBe("failed");
    expect(record.endedBecause).toBe(guard);
    expect(record.run.error).toBe(guard);
    // Partial evidence survives, and the unreached intervals are not filed as having happened.
    expect(record.audit).toHaveLength(1);
    expect(record.run.ticks.map(t => t.tick)).toEqual([0]);
    const repeated = await f.session.finalize({ status: "done", reason: "the simulated day ended" });
    expect(repeated.run.status).toBe("failed");
    expect(repeated.endedBecause).toBe(guard);
    expect(repeated.audit).toHaveLength(1);
  });
});
