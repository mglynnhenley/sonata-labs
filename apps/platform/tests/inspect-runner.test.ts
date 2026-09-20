import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-inspect-runner-"));
process.env.SONATA_RUNS_DIR = sandbox;
const { finishInspect } = await import("../src/lib/engine/inspect");

function fixture(id: string, exported = true) {
  const dir = path.join(sandbox, "inspect", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(sandbox, `${id}.json`), JSON.stringify({
    runId: id, status: "done", ticks: [], snapshots: {},
    verdict: { score: 1, judge: { model: "judge/model" }, cost: { usd: 0.1 } },
    session: { caveats: ["Agent-side model usage and reasoning are external; consult the linked harness transcript."] },
  }));
  const call = { seq: 1, model: "test/model", request: {}, response: {}, startedAt: 2, endedAt: 3, costUsd: 0.2 };
  writeFileSync(path.join(sandbox, `${id}.trace.json`), JSON.stringify({ runId: id, toolCalls: [],
    llmCalls: [{ ...call, role: "director", startedAt: 1, costUsd: 0.1 }, { ...call, role: "judge", startedAt: 4, costUsd: 0.3 }] }));
  if (exported) writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ runId: id, log: "sample.eval", status: "success",
    llmCalls: [{ ...call, role: "agent" }], agentSummary: "Saved the handoff." }));
  return dir;
}

describe("Inspect evidence becomes the saved product run", () => {
  it("joins the agent calls without losing world or rejudge evidence, and is idempotent", () => {
    const id = "run_join";
    const dir = fixture(id);
    finishInspect(id, dir);
    const run = finishInspect(id, dir);
    const trace = JSON.parse(readFileSync(path.join(sandbox, `${id}.trace.json`), "utf8"));
    expect(trace.llmCalls.map((c: { role: string }) => c.role)).toEqual(["director", "agent", "judge"]);
    expect(trace.agentSummary).toBe("Saved the handoff.");
    expect(run.verdict?.cost.usd).toBeCloseTo(0.6);
    expect(run.verdict?.judge?.model).toBe("judge/model");
    expect(run.inspect?.sessionId).toBe(id);
  });
  it("refuses a completed score when the worker did not export its evidence", () => {
    const id = "run_missing";
    const run = finishInspect(id, fixture(id, false));
    expect(run.status).toBe("failed");
    expect(run.verdict).toBeNull();
    expect(run.error).toContain("unmeasured");
  });
  it("keeps a cancelled run unscored even if the world reached its last tick", () => {
    const id = "run_cancel";
    const run = finishInspect(id, fixture(id), "Declared spend budget exhausted", true);
    expect(run.status).toBe("aborted");
    expect(run.verdict).toBeNull();
    expect(run.error).toContain("spend budget");
  });
  it("withholds a score when the gateway paid for a call missing from the export", () => {
    const id = "run_gateway_gap";
    const dir = fixture(id);
    writeFileSync(path.join(dir, "model-gateway.json"), JSON.stringify({ runId: id, spend: { usd: 0.5, calls: 2, unpriced: 0 } }));
    const run = finishInspect(id, dir);
    expect(run.status).toBe("failed");
    expect(run.verdict).toBeNull();
    expect(run.inspect?.modelGateway?.usd).toBe(0.5);
    expect(run.error).toContain("unmeasured");
  });
  it("does not double-count gateway spend already captured by Inspect", () => {
    const id = "run_gateway_complete";
    const dir = fixture(id);
    writeFileSync(path.join(dir, "model-gateway.json"), JSON.stringify({ runId: id, spend: { usd: 0.2, calls: 1, unpriced: 0 } }));
    const run = finishInspect(id, dir);
    expect(run.status).toBe("done");
    expect(run.verdict?.cost.usd).toBeCloseTo(0.6);
  });
  it("rejects evidence from another session", () => {
    const id = "run_wrong";
    const dir = fixture(id);
    writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ runId: "other", llmCalls: [] }));
    expect(() => finishInspect(id, dir)).toThrow("different run");
  });
});
