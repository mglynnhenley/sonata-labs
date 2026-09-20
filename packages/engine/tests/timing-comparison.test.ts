import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { ExcelWorkbook, SessionTimingPolicy, SlackSnapshot } from "@sonata/core";
import { createSession, type Session, type SessionTimer } from "../src/session";
import { auditRow, fakeAdapter, spec } from "./fixtures";

// Matched, offline business fixture: mark four supplied rows checked, then post
// the handoff before tick 2. These units are experimental API-operation charges,
// not human work minutes. The app fakes preserve real snapshot/audit shapes; the
// actual session owns advancement, event ordering, admission and final capture.
const TICKS = 4;
const DEADLINE = 2;
const REAL_TICK_MS = 1_000;
const START_ISO = "2026-08-04T09:00:00.000Z";
const ROW_IDS = ["a", "b", "c", "d"];
const HANDOFF = "All four supplied rows checked; workbook ready for review.";

type Operation =
  | { id: string; kind: "read"; workUnits: 1 }
  | { id: string; kind: "edit"; rows: string[]; workUnits: number }
  | { id: string; kind: "handoff"; workUnits: 2 };

type Workflow = "batch" | "individual" | "read-heavy";
interface Latency { model: number; tool: number; world: number }
const NO_LATENCY: Latency = { model: 0, tool: 0, world: 0 };

function operations(workflow: Workflow): Operation[] {
  const reads: Operation[] = Array.from({ length: workflow === "read-heavy" ? 7 : 1 },
    (_, i) => ({ id: `read-${i}`, kind: "read", workUnits: 1 }));
  const groups = workflow === "individual" ? ROW_IDS.map(id => [id]) : [ROW_IDS];
  return [...reads, ...groups.map((rows, i): Operation => ({
    id: `edit-${i}`, kind: "edit", rows, workUnits: 2 * rows.length,
  })), { id: "handoff", kind: "handoff", workUnits: 2 }];
}

function fixtureTimer(): SessionTimer & {
  elapse(ms: number): void;
  advance(ms: number, session: Session): Promise<void>;
} {
  let now = 10_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule(ms, fn) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return () => { timers.delete(id); };
    },
    // A provider/world operation can consume wall time while its promise is in
    // flight. Drain due callbacks after it completes, without rewinding time.
    elapse(ms) { now += ms; },
    async advance(ms, session) {
      let target = now + ms;
      for (let n = 0; n < 100; n++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) { now = Math.max(now, target); return; }
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        for (let i = 0; i < 4; i++) await session.whenSettled();
        target = Math.max(target, now);
      }
      throw new Error("Fixture timer did not settle after 100 callbacks");
    },
  };
}

interface Comparison {
  policy: string;
  workflow: Workflow;
  workUnitsPerTick?: number;
  latency: Latency;
  rows: string[];
  handoff: boolean;
  handoffTick: number | null;
  beforeDeadline: boolean;
  plannedOperations: number;
  acceptedOperations: number;
  wallElapsedMs: number;
  eventOrder: string[];
  logicalActions: Array<{ operation: string; tick: number; simTimeISO: string }>;
  capturedWrites: number;
  chargedUnits: number;
  status: string;
}

const comparisons: Comparison[] = [];

async function replay(
  workflow: Workflow,
  timing: SessionTimingPolicy,
  latency: Latency = NO_LATENCY,
): Promise<Comparison> {
  const timer = fixtureTimer();
  const excel = fakeAdapter("excel");
  const slack = fakeAdapter("slack");
  const workbook: ExcelWorkbook = {
    id: "checks", title: "Supplied rows", revision: 0,
    sheets: [{ id: "rows", name: "Rows", columns: [{ key: "status", label: "Status", type: "text" }],
      rows: ROW_IDS.map(id => ({ id, values: { status: "unchecked" } })) }],
  };
  const messages: SlackSnapshot["messages"] = [];
  excel.snapshot = async () => ({ twin: "excel", capturedAt: timer.now(),
    workbooks: [structuredClone(workbook)], changes: [] });
  slack.snapshot = async () => ({ twin: "slack", capturedAt: timer.now(),
    channels: [], messages: structuredClone(messages) });
  const episode = spec({
    id: "timing-matched-fixture",
    clock: { startISO: START_ISO, ticks: TICKS, simMinutesPerTick: 15 },
    beats: [{ id: "review-window-closed", tick: DEADLINE, twin: "slack", kind: "message",
      payload: { from: "sam", channel: "ops", text: "The review window is now closed." } }],
    success: { checklist: [
      { id: "rows", description: "All supplied rows checked", twin: "excel", kind: "judged", weight: 1, severity: "must" },
      { id: "handoff", description: "Handoff before the review window closes",
        twin: "slack", kind: "posted", expect: "ops", before: "t2", weight: 1, severity: "must" },
    ], judgeQuestions: [] },
  });
  const session = createSession({
    spec: episode, adapters: [excel, slack], compression: 900, timing, timer,
    sessionId: "timing-comparison",
    director: { async react() { timer.elapse(latency.world); return []; }, lastNote: () => undefined },
  });
  const planned = operations(workflow);
  const admitted: Array<{ operation: string; tick: number; simTimeISO: string }> = [];
  const started = timer.now();
  let handoffTick: number | null = null;
  try {
    await session.start();
    for (const op of planned) {
      await timer.advance(latency.model, session);
      const permit = await session.beginAction({ actionId: op.id, workUnits: op.workUnits,
        operation: op.kind === "read" ? "GET excel/workbooks/checks" :
          op.kind === "edit" ? "POST excel/cells" : "POST slack/chat.postMessage" });
      if (!permit.accepted) break;
      admitted.push({ operation: op.id, tick: permit.completionTick, simTimeISO: permit.simTimeISO });
      // Tool transport consumes real time after admission. Business-time policy
      // and its barrier remain engine concerns; no fixture clock is advanced.
      timer.elapse(latency.tool);
      if (op.kind === "edit") {
        workbook.revision++;
        for (const id of op.rows) {
          workbook.sheets[0].rows.find(row => row.id === id)!.values.status = "checked";
          excel.rows.push(auditRow({ twin: "excel", id: excel.rows.length + 1,
            ts: timer.now(), actionType: "update", targetType: "row", targetId: id,
            summary: `Checked row ${id}` }));
        }
      } else if (op.kind === "handoff") {
        handoffTick = (Date.parse(permit.simTimeISO) - Date.parse(START_ISO)) / (15 * 60_000);
        messages.push({ channelId: "C01OPS", channelName: "ops", ts: String(timer.now() / 1_000),
          user: "U01PRIYA", text: HANDOFF, replyCount: 0, reactions: [] });
        slack.rows.push(auditRow({ twin: "slack", id: slack.rows.length + 1,
          ts: timer.now(), actionType: "post", targetId: "C01OPS/handoff", summary: HANDOFF }));
      }
      await session.completeAction(op.id);
      await timer.advance(0, session);
    }
    if (timing.policy === "compressed-wall-time") {
      await timer.advance(TICKS * REAL_TICK_MS, session);
    } else {
      await session.finishWork();
    }
    const record = await session.finished();
    const finalExcel = record.run.snapshots.excel?.after;
    const finalSlack = record.run.snapshots.slack?.after;
    if (finalExcel?.twin !== "excel" || finalSlack?.twin !== "slack") {
      throw new Error("Matched fixture lost its final business snapshots");
    }
    const summary: Comparison = {
      policy: timing.policy, workflow,
      ...(timing.policy === "provider-operations-v1" ? { workUnitsPerTick: timing.workUnitsPerTick } : {}),
      latency,
      rows: finalExcel.workbooks[0].sheets[0].rows.filter(row => row.values.status === "checked").map(row => row.id),
      handoff: finalSlack.messages.some(message => message.text === HANDOFF),
      handoffTick, beforeDeadline: handoffTick !== null && handoffTick < DEADLINE,
      plannedOperations: planned.length, acceptedOperations: admitted.length,
      wallElapsedMs: (record.run.endedAt ?? timer.now()) - (record.run.startedAt ?? started),
      eventOrder: record.run.ticks.flatMap(t => t.beatsFired.map(b => `${t.tick}:${b.beatId}`)),
      logicalActions: admitted, capturedWrites: record.audit.length,
      chargedUnits: (record.run.actionLedger ?? []).filter(row => row.state === "completed")
        .reduce((sum, row) => sum + row.workUnits, 0),
      status: record.run.status,
    };
    if (timing.policy === "provider-operations-v1") {
      // Assert the captured artifact agrees with admission rather than deriving
      // the purported deadline outcome from the fixture's work-unit arithmetic.
      for (const row of record.audit) expect(row.logicalTime).toBeDefined();
      const handoff = record.audit.find(row => row.twin === "slack");
      expect(handoff?.logicalTime?.tick ?? null).toBe(handoffTick === null ? null : Math.floor(handoffTick));
      if (handoff) expect(handoff.logicalTime?.simTimeISO).toBe(admitted.at(-1)?.simTimeISO);
    }
    comparisons.push(summary);
    return summary;
  } finally {
    await session.stop("timing comparison cleanup");
  }
}

// An explicit fixture reference, not the deleted product agent loop or a claim
// to reproduce its 40-model-step limit. Two provider opportunities share each
// frozen tick. It makes the opportunity-policy batching bias observable.
function historicalOpportunities(workflow: Workflow): Pick<Comparison,
  "policy" | "workflow" | "handoffTick" | "beforeDeadline" | "acceptedOperations"> {
  const planned = operations(workflow);
  const handoffIndex = planned.findIndex(op => op.kind === "handoff");
  const handoffTick = Math.floor(handoffIndex / 2);
  return { policy: "historical-fixed-opportunities-fixture", workflow,
    handoffTick: handoffTick < TICKS ? handoffTick : null,
    beforeDeadline: handoffTick < DEADLINE,
    acceptedOperations: Math.min(planned.length, 2 * TICKS) };
}

function business(result: Comparison) {
  return { rows: result.rows, handoff: result.handoff, beforeDeadline: result.beforeDeadline };
}

describe("matched timing-policy comparison", () => {
  it.each([
    { model: 100, tool: 0, world: 0 },
    { model: 0, tool: 100, world: 0 },
    { model: 0, tool: 0, world: 100 },
    { model: 1_000, tool: 1_000, world: 1_000 },
  ])("keeps candidate business evidence invariant under latency %j", async latency => {
    const timing = { policy: "provider-operations-v1", workUnitsPerTick: 12 } as const;
    const fast = await replay("individual", timing);
    const delayed = await replay("individual", timing, latency);
    expect(business(delayed)).toEqual({ rows: ROW_IDS, handoff: true, beforeDeadline: true });
    expect(business(delayed)).toEqual(business(fast));
    expect(delayed.logicalActions).toEqual(fast.logicalActions);
    expect(delayed.eventOrder).toEqual(["2:review-window-closed"]);
    expect(delayed.capturedWrites).toBe(5);
    expect(delayed.wallElapsedMs).toBeGreaterThan(fast.wallElapsedMs);
  });

  it("exposes compressed-wall sensitivity without forcing late script actions", async () => {
    const timing = { policy: "compressed-wall-time" } as const;
    const fast = await replay("individual", timing);
    const slow = await replay("individual", timing, { model: 1_000, tool: 1_000, world: 100 });
    expect(business(fast)).toEqual({ rows: ROW_IDS, handoff: true, beforeDeadline: true });
    expect(slow.acceptedOperations).toBeLessThan(slow.plannedOperations);
    expect(slow.handoff).toBe(false);
    expect(slow.beforeDeadline).toBe(false);
    expect(slow.status).toBe("done");
  });

  it.each([6, 12, 24])("preserves batch/single work equivalence at %i units per tick", async workUnitsPerTick => {
    const timing = { policy: "provider-operations-v1", workUnitsPerTick } as const;
    const batch = await replay("batch", timing);
    const individual = await replay("individual", timing);
    expect(business(batch)).toEqual({ rows: ROW_IDS, handoff: true, beforeDeadline: true });
    expect(business(individual)).toEqual(business(batch));
    expect(batch.chargedUnits).toBe(11);
    expect(individual.chargedUnits).toBe(11);
    expect(batch.handoffTick).toBeCloseTo(individual.handoffTick!);
    expect(batch.acceptedOperations).toBe(3);
    expect(individual.acceptedOperations).toBe(6);
  });

  it("reports budget sensitivity for an alternative valid, more-read-heavy workflow", async () => {
    const rows = await Promise.all([6, 12, 24].map(workUnitsPerTick => replay("read-heavy",
      { policy: "provider-operations-v1", workUnitsPerTick })));
    expect(rows.map(row => row.beforeDeadline)).toEqual([false, true, true]);
    for (const row of rows) {
      expect(row.rows).toEqual(ROW_IDS);
      expect(row.handoff).toBe(true);
      expect(row.chargedUnits).toBe(17);
    }
  });

  it("compares all three assumptions and discloses the historical fixture's batching bias", async () => {
    const historicalBatch = historicalOpportunities("batch");
    const historicalIndividual = historicalOpportunities("individual");
    const timing = { policy: "provider-operations-v1", workUnitsPerTick: 12 } as const;
    const candidate = await replay("individual", timing);
    const wall = await replay("individual", { policy: "compressed-wall-time" });
    expect([historicalBatch.beforeDeadline, historicalIndividual.beforeDeadline]).toEqual([true, false]);
    expect([candidate.beforeDeadline, wall.beforeDeadline]).toEqual([true, true]);
    expect(historicalIndividual.handoffTick).toBe(DEADLINE);
    expect(candidate.handoffTick).toBeCloseTo(11 / 12);
    expect(wall.handoffTick).toBe(0);
  });
});

afterAll(() => {
  const output = process.env.SONATA_TIMING_COMPARISON_OUTPUT;
  if (!output) return;
  writeFileSync(output, `${JSON.stringify({
    fixture: "four checked rows and a handoff before tick 2; four-tick episode",
    durationClaim: "Experimental provider work units, not human-validated durations",
    execution: "Offline real engine, fake app adapters, manually advanced wall timer; no model calls",
    historicalReference: [historicalOpportunities("batch"), historicalOpportunities("individual")],
    comparisons,
  }, null, 2)}\n`);
});
