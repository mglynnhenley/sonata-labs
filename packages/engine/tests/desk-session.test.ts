import { describe, expect, it } from "vitest";
import type { EpisodeSpec } from "@sonata/core";
import { createSession, type SessionOptions, type SessionTimer } from "../src/session";
import type { DeskControl } from "../src/adapters/desk";
import { fakeAdapter, spec } from "./fixtures";

// A continuity week driven by a session, which is what the Inspect path drives.
//
// The engine's own `runEpisode` has always been able to run one of these, in
// process, against a desk it constructed itself. A session is different: the
// desk is a service behind HTTP, the agent is somewhere else entirely, and the
// only thing joining them is that the session advances the week on the same
// instants the agent is working. These pin that join.

/** A desk that records what it was told, standing in for the service. */
function recordingDesk(over: Partial<DeskControl> = {}) {
  const advanced: Array<{ at: string; phase: string }> = [];
  const assessed: Array<string | null> = [];
  const control: DeskControl = {
    async advance(at, phase) { advanced.push({ at, phase }); },
    async assess(completedThrough) {
      assessed.push(completedThrough);
      return {
        caseId: "E01",
        criteria: [{ id: "EO01", family: "preparation", units: [{ id: "u1", score: 2, evidence: ["R1"], reason: "done" }] }],
        incidents: [],
        limitations: [],
      };
    },
    ...over,
  };
  return { control, advanced, assessed };
}

const week = (over: Partial<EpisodeSpec["clock"]> = {}): EpisodeSpec => spec({
  clock: {
    startISO: "2026-08-04T09:00:00Z",
    ticks: 3,
    simMinutesPerTick: 15,
    tickISOs: ["2026-08-04T09:00:00.000Z", "2026-08-04T09:15:00.000Z", "2026-08-05T09:00:00.000Z"],
    endISO: "2026-08-05T09:15:00.000Z",
    ...over,
  },
  benchmark: { kind: "continuity", caseId: "E01", version: 1 },
});

function fixture(over: Partial<SessionOptions> = {}) {
  let now = 1000;
  const timer: SessionTimer = { now: () => now, schedule: () => () => {} };
  const desk = recordingDesk();
  const session = createSession({
    spec: week(), adapters: [fakeAdapter("desk")], compression: 60, timer,
    timing: { policy: "provider-operations-v1", workUnitsPerTick: 12 },
    director: { react: async () => [], lastNote: () => undefined },
    desk: desk.control,
    ...over,
  });
  return { session, desk, advanceReal(ms: number) { now += ms; } };
}

describe("a continuity week through a session", () => {
  it("refuses to start a benchmark spec with no way to advance the week", () => {
    expect(() => createSession({
      spec: week(), adapters: [fakeAdapter("desk")], compression: 60,
      timer: { now: () => 0, schedule: () => () => {} },
      director: { react: async () => [], lastNote: () => undefined },
    })).toThrow(/E01 needs its desk control plane/);
  });

  it("advances the week on the authored instants, before and after each interval", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.finishWork();
    // Both phases on every observed opportunity, in order, on the spec's own
    // instants — not on a 15-minute grid, which would put Tuesday at 09:30 Monday.
    expect(f.desk.advanced).toEqual([
      { at: "2026-08-04T09:00:00.000Z", phase: "before" },
      { at: "2026-08-04T09:00:00.000Z", phase: "after" },
      { at: "2026-08-04T09:15:00.000Z", phase: "before" },
      { at: "2026-08-04T09:15:00.000Z", phase: "after" },
      { at: "2026-08-05T09:00:00.000Z", phase: "before" },
      { at: "2026-08-05T09:00:00.000Z", phase: "after" },
    ]);
  });

  it("marks a whole observed week complete, through the declared horizon", async () => {
    const f = fixture();
    await f.session.start();
    const record = await f.session.finishWork();
    expect(f.desk.assessed).toEqual(["2026-08-05T09:15:00.000Z"]);
    expect(record.run.benchmark).toMatchObject({ caseId: "E01", completion: "complete", completedTicks: 3 });
  });

  it("marks a week that stopped early partial, through the last interval it saw", async () => {
    const f = fixture();
    await f.session.start();
    const record = await f.session.stop("the operator stopped it");
    // One opportunity observed, so the horizon is that opportunity — not the
    // week's end, which would credit the agent with four days it never saw.
    expect(f.desk.assessed).toEqual(["2026-08-04T09:00:00.000Z"]);
    expect(record.run.benchmark).toMatchObject({ completion: "failed", completedTicks: 1 });
  });

  it("keeps the ledger and says so when the assessment cannot be read", async () => {
    const f = fixture({ desk: { ...recordingDesk().control, assess: async () => { throw new Error("desk unreachable"); } } });
    await f.session.start();
    const record = await f.session.finishWork();
    expect(record.run.benchmark).toBeUndefined();
    expect(record.run.ticks.flatMap(t => t.notes).join(" ")).toContain("desk unreachable");
    // The week itself still ran and its evidence is still filed.
    expect(record.run.ticks).toHaveLength(3);
  });

  it("files a failed advance as a harness fault, not as a quiet morning", async () => {
    const desk = recordingDesk({ advance: async () => { throw new Error("desk refused to advance"); } });
    const f = fixture({ desk: desk.control });
    await f.session.start();
    const record = await f.session.finishWork();
    expect(record.run.ticks[0]!.harnessError).toContain("desk refused to advance");
  });
});
