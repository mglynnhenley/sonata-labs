import http, { type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createSession } from "@sonata/engine/session";
import { realTimer } from "@sonata/engine/live";
import { auditRow, fakeAdapter, spec } from "../../../packages/engine/tests/fixtures";
import { startTimingController } from "../src/lib/engine/timingController";

const { createGateway } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../../integrations/runtime/gateway.mjs")).href);
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(options: { latency?: number; units?: number; beforeWrite?: () => Promise<void> } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "sonata-timing-controller-"));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const adapter = fakeAdapter("slack");
  const upstream = await listen(http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain the request */ }
    await options.beforeWrite?.();
    if (options.latency) await delay(options.latency);
    adapter.rows.push(auditRow({ id: adapter.rows.length + 1, twin: "slack", ts: Date.now(), summary: "Saved handoff" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  }));
  const timing = { policy: "provider-operations-v1" as const, workUnitsPerTick: options.units ?? 12 };
  const token = "separate-timing-credential-for-fixture";
  const gateway = createGateway({ upstreams: { slack: upstream }, timing: { ...timing, token, pollTimeoutMs: 50 } });
  const provider = await listen(gateway);
  const control = await listen(gateway.timing.server);
  let controller: ReturnType<typeof startTimingController> | undefined;
  const session = createSession({ spec: spec({ beats: [{ id: "start", tick: 0, twin: "slack", kind: "message", payload: { channel: "ops", from: "sam", text: "Morning" } }], clock: { startISO: "2026-08-04T09:00:00Z", ticks: 1, simMinutesPerTick: 15 } }),
    adapters: [adapter], compression: 60, timing, timer: realTimer(), seedWorld: false, resetTwins: false,
    director: { react: async () => [], lastNote: () => undefined }, beforeCapture: async () => { await controller?.close(); },
  });
  await session.start();
  const failures: Error[] = [];
  controller = startTimingController({ control: { url: control, token }, session,
    ledgerPath: path.join(directory, "host.jsonl"), onFailure(error) {
      failures.push(error);
      void session.finalize({ status: "failed", reason: error.message, error: error.message });
    },
  });
  cleanup.push(async () => { await session.finalize({ status: "aborted" }); await controller?.stop(); });
  const write = () => fetch(`${provider}/slack/api/chat.postMessage`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer employee" },
    body: JSON.stringify({ channel: "C01OPS", text: "Saved handoff" }),
  });
  return { session, write, failures, directory };
}

it("real HTTP operations have the same simulated attribution despite provider latency", async () => {
  const outcomes = [];
  for (const latency of [0, 50]) {
    const f = await fixture({ latency });
    expect((await f.write()).status).toBe(200);
    const result = await f.session.finishWork();
    expect(f.failures).toEqual([]);
    expect(result.run.status).toBe("done");
    expect(result.audit).toHaveLength(1);
    outcomes.push({ time: result.audit[0].logicalTime?.simTimeISO, tick: result.audit[0].logicalTime?.tick,
      units: result.run.actionLedger?.[0].completionWorkUnits });
    expect(readFileSync(path.join(f.directory, "host.jsonl"), "utf8")).toContain('"kind":"completion"');
  }
  expect(outcomes[0]).toEqual(outcomes[1]);
  expect(outcomes[0]).toMatchObject({ time: "2026-08-04T09:02:30.000Z", tick: 0, units: 2 });
}, 10_000);

it("rejects work crossing day end without deadlocking the final gateway drain", async () => {
  const f = await fixture({ units: 3 });
  expect((await f.write()).status).toBe(200);
  expect((await f.write()).status).toBe(409);
  const result = await f.session.finished();
  expect(result.run.status).toBe("done");
  expect(result.audit).toHaveLength(1);
  expect(f.failures).toEqual([]);
}, 10_000);

it("cancellation waits for an admitted mutation before capturing its evidence", async () => {
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ beforeWrite: async () => { entered(); await held; } });
  const response = f.write();
  await writing;
  let captured = false;
  const finished = f.session.finalize({ status: "aborted", reason: "Operator cancelled" }).then(result => { captured = true; return result; });
  await delay(40);
  expect(captured).toBe(false);
  release();
  expect((await response).status).toBe(200);
  const result = await finished;
  expect(result.run.status).toBe("aborted");
  expect(result.audit).toHaveLength(1);
  expect(result.audit[0].logicalTime?.simTimeISO).toBe("2026-08-04T09:02:30.000Z");
  expect(f.failures).toEqual([]);
}, 10_000);
