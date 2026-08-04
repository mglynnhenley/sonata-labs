import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { planMatrix, type Cell } from "../src/plan";
import { runBenchmark, type BenchmarkEvent, type RunEpisode } from "../src/run";
import { listRunIds, readReport, readRunArtifact, writeRunArtifact } from "../src/store";
import { cost, episodeRun, MATRIX, type RunOver } from "./fixtures";

// Nothing here calls a model or a twin: the engine is injected, so the runner's
// own behaviour — order, resume, budget, failure isolation — is testable offline.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sonata-bench-run-"));
});

/** A fake engine that records the order it was called in. */
function fakeEngine(over: (cell: Cell) => RunOver = () => ({})) {
  const seen: string[] = [];
  const run: RunEpisode = async (cell) => {
    seen.push(cell.runId);
    return { run: episodeRun({ runId: cell.runId, model: cell.model, ...over(cell) }) };
  };
  return { run, seen };
}

/** A clock that ticks a fixed amount per read, so reports are byte-comparable. */
function fakeClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

describe("runBenchmark", () => {
  it("runs every pending cell in plan order and writes one artifact each", async () => {
    const plan = planMatrix(MATRIX);
    const engine = fakeEngine();

    const report = await runBenchmark(plan, { dir, run: engine.run, now: fakeClock() });

    expect(engine.seen).toEqual(plan.cells.map((c) => c.runId));
    expect(listRunIds(dir).sort()).toEqual([...plan.cells.map((c) => c.runId)].sort());
    expect(report.results).toHaveLength(8);
    expect(report.aggregate.episodes).toBe(8);
  });

  it("never has two episodes in flight — the twins hold one mutable world", async () => {
    const plan = planMatrix(MATRIX);
    let inFlight = 0;
    let maxInFlight = 0;

    const run: RunEpisode = async (cell) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { run: episodeRun({ runId: cell.runId, model: cell.model }) };
    };

    await runBenchmark(plan, { dir, run, now: fakeClock() });
    // If this ever reads 2, some cell was handed a mailbox containing another
    // model's replies and every number in the table is meaningless.
    expect(maxInFlight).toBe(1);
  });

  it("resumes: cells already on disk are read back, not re-run", async () => {
    const first = planMatrix(MATRIX);
    // Pretend two cells finished in an earlier session.
    for (const cell of first.cells.slice(0, 2)) {
      writeRunArtifact(dir, episodeRun({ runId: cell.runId, model: cell.model, autonomy: 0.5 }));
    }

    const plan = planMatrix(MATRIX, listRunIds(dir));
    const engine = fakeEngine();
    const events: BenchmarkEvent[] = [];

    const report = await runBenchmark(plan, {
      dir,
      run: engine.run,
      now: fakeClock(),
      onEvent: (e) => events.push(e),
    });

    expect(engine.seen).toHaveLength(6);
    expect(engine.seen).not.toContain(first.cells[0].runId);
    // The resumed cells still belong in the table — a resumed benchmark
    // aggregates the whole matrix, not just today's part.
    expect(report.results).toHaveLength(8);
    expect(report.aggregate.episodes).toBe(8);
    expect(events.filter((e) => e.kind === "resumed")).toHaveLength(2);
  });

  it("re-runs a cell whose artifact vanished between planning and running", async () => {
    const vanished = planMatrix(MATRIX).cells[0].runId;
    const plan = planMatrix(MATRIX, [vanished]);
    const engine = fakeEngine();
    const report = await runBenchmark(plan, { dir, run: engine.run, now: fakeClock() });

    // Planned as done, but nothing is there to read back: it contributes no
    // result, and the next plan picks it up again.
    expect(engine.seen).toHaveLength(7);
    expect(report.results).toHaveLength(7);
    expect(planMatrix(MATRIX, listRunIds(dir)).pending.map((c) => c.runId)).toEqual([vanished]);
  });

  it("records a cell that threw and keeps going", async () => {
    const plan = planMatrix(MATRIX);
    const failing = plan.cells[2].runId;
    const events: BenchmarkEvent[] = [];

    const run: RunEpisode = async (cell) => {
      if (cell.runId === failing) throw new Error("provider 400");
      return { run: episodeRun({ runId: cell.runId, model: cell.model }) };
    };

    const report = await runBenchmark(plan, {
      dir,
      run,
      now: fakeClock(),
      onEvent: (e) => events.push(e),
    });

    expect(report.results).toHaveLength(8);
    const failed = report.results.find((r) => r.runId === failing);
    expect(failed).toMatchObject({ status: "failed", autonomy: 0, error: "provider 400" });
    // No artifact, so resuming retries it — the usual cause is transient.
    expect(readRunArtifact(dir, failing)).toBeNull();
    expect(events.filter((e) => e.kind === "cell-failed")).toHaveLength(1);
    expect(report.aggregate.failed).toBe(1);
  });

  it("takes the override cost for a run that died before it had a verdict", async () => {
    const plan = planMatrix({ ...MATRIX, seeds: [1], scenarioIds: ["sla-escalation"], models: ["m1"] });
    const run: RunEpisode = async (cell) => ({
      run: episodeRun({ runId: cell.runId, model: cell.model, noVerdict: true, status: "failed" }),
      cost: cost({ usd: 0.42 }),
    });

    const report = await runBenchmark(plan, { dir, run, now: fakeClock() });
    expect(report.results[0].cost.usd).toBe(0.42);
    expect(report.aggregate.totalCostUsd).toBe(0.42);
  });

  it("stops before starting a cell once the budget is spent", async () => {
    const plan = planMatrix(MATRIX);
    const engine = fakeEngine(() => ({ usd: 0.5 }));
    const events: BenchmarkEvent[] = [];

    const report = await runBenchmark(plan, {
      dir,
      run: engine.run,
      budgetUsd: 1,
      now: fakeClock(),
      onEvent: (e) => events.push(e),
    });

    // Two cells at $0.50 reach the budget; the third is never started.
    expect(engine.seen).toHaveLength(2);
    expect(report.stopped).toEqual({ reason: "budget", spentUsd: 1 });
    expect(events.at(-1)).toMatchObject({ kind: "stopped", reason: "budget" });
    // A partial table is still written — it is what you look at to decide
    // whether to raise the budget.
    expect(readReport(dir, MATRIX.id)?.results).toHaveLength(2);
  });

  it("counts resumed spend against the budget", async () => {
    const all = planMatrix(MATRIX);
    for (const cell of all.cells.slice(0, 2)) {
      writeRunArtifact(dir, episodeRun({ runId: cell.runId, model: cell.model, usd: 0.6 }));
    }
    const plan = planMatrix(MATRIX, listRunIds(dir));
    const engine = fakeEngine(() => ({ usd: 0.6 }));

    const report = await runBenchmark(plan, {
      dir,
      run: engine.run,
      budgetUsd: 1,
      now: fakeClock(),
    });

    // $1.20 was already spent before this session started.
    expect(engine.seen).toHaveLength(0);
    expect(report.stopped?.reason).toBe("budget");
  });

  it("stops on an abort signal without discarding what already ran", async () => {
    const plan = planMatrix(MATRIX);
    const controller = new AbortController();
    let calls = 0;

    const run: RunEpisode = async (cell) => {
      if (++calls === 2) controller.abort();
      return { run: episodeRun({ runId: cell.runId, model: cell.model }) };
    };

    const report = await runBenchmark(plan, {
      dir,
      run,
      signal: controller.signal,
      now: fakeClock(),
    });

    expect(calls).toBe(2);
    expect(report.stopped?.reason).toBe("aborted");
    expect(report.results).toHaveLength(2);
    expect(listRunIds(dir)).toHaveLength(2);
  });

  it("writes an aggregate that regenerates from the artifacts it wrote", async () => {
    const plan = planMatrix(MATRIX);
    const engine = fakeEngine((cell) => ({ autonomy: cell.seed === 1 ? 0.6 : 0.8 }));

    const report = await runBenchmark(plan, { dir, run: engine.run, now: fakeClock() });
    const onDisk = readReport(dir, MATRIX.id);

    expect(onDisk).toEqual(report);
    expect(report.aggregate.byModel.every((m) => m.meanAutonomy === 0.7)).toBe(true);
    // Every scenario cell saw both seeds: variance is ((0.1)^2 * 2) / 2 = 0.01.
    expect(report.aggregate.byModel[0].seedVariance).toBeCloseTo(0.01, 12);
  });
});
