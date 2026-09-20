import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createGateway, parseTarget, providerRouteAllowed } from "./gateway.mjs";
import { providerOperation, MAX_BATCH_ITEMS } from "./gateway-profile.mjs";

const TOKEN = "private-timing-token-with-at-least-32-characters";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
function request(origin, resource, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const bytes = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ hostname: url.hostname, port: url.port, path: resource, method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers, "content-length": Buffer.byteLength(bytes) } }, async res => {
      const chunks = [];
      try {
        for await (const chunk of res) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, text, data: text ? JSON.parse(text) : undefined });
      } catch (error) { reject(error); }
    });
    req.once("error", reject);
    req.end(bytes);
  });
}
async function fixture(t, { handler, timing = {}, upstreamTimeoutMs, ledger = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sonata-gateway-timing-"));
  const received = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ method: req.method, path: req.url, body, headers: req.headers });
    if (handler) await handler(req, res, body);
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, body })); }
  });
  const upstream = await listen(backend);
  const gateway = createGateway({ upstreams: Object.fromEntries(["gmail", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel"].map(twin => [twin, upstream])), upstreamTimeoutMs,
    timing: { policy: "provider-operations-v1", workUnitsPerTick: 12, token: TOKEN, pollTimeoutMs: 20,
      ...(ledger ? { ledgerPath: path.join(directory, "provider-operations.jsonl") } : {}), ...timing } });
  const origin = await listen(gateway);
  const controlOrigin = await listen(gateway.timing.server);
  t.after(async () => {
    gateway.timing.dispose();
    for (const server of [gateway, backend]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const control = (resource, body) => request(controlOrigin, resource, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
  const next = async kind => {
    for (let i = 0; i < 100; i++) {
      const response = await control("/next");
      assert.ok([200, 204].includes(response.status), response.text);
      if (response.status === 204) continue;
      assert.equal(response.data.kind, kind, response.text);
      return response.data;
    }
    throw new Error(`No ${kind} event arrived.`);
  };
  const ack = async event => assert.equal((await control("/ack", { actionId: event.actionId })).status, 200);
  return { origin, controlOrigin, control, next, ack, received, gateway,
    ledger: () => readFileSync(path.join(directory, "provider-operations.jsonl"), "utf8").trim().split("\n").map(JSON.parse) };
}

test("direct HTTP is admitted once and remains serial until audit acknowledgement", async t => {
  const f = await fixture(t);
  const body = '{"channel":"C1","text":"Exact original arguments","metadata":{"units":0}}';
  let returned = false;
  const first = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body, headers: { authorization: "Bearer provider-only" } }).then(value => { returned = true; return value; });
  const admitted = await f.next("request");
  assert.equal(admitted.workUnits, 2);
  assert.equal(admitted.bodySha256, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(await f.next("request"), admitted, "delivery can be retried without changing the request");
  const second = request(f.origin, "/excel/api/workbooks/book1");
  assert.equal(f.received.length, 0);
  assert.equal((await f.control("/decision", { actionId: admitted.actionId, accepted: true, method: "DELETE", body: "changed" })).status, 200);
  const complete = await f.next("completion");
  assert.equal(complete.status, 200);
  assert.equal(complete.dispatched, true);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].body, body);
  assert.equal(f.received[0].headers.authorization, "Bearer provider-only");
  assert.equal(returned, false);
  assert.equal((await f.control("/decision", { actionId: admitted.actionId, accepted: true })).status, 409);
  assert.equal((await f.control("/ack", { actionId: "model-chosen-id" })).status, 409);
  await f.ack(complete);
  assert.equal((await first).status, 200);
  const read = await f.next("request");
  assert.equal(read.workUnits, 1);
  assert.notEqual(read.actionId, admitted.actionId);
  assert.equal((await f.control("/decision", { actionId: read.actionId, accepted: true })).status, 200);
  await f.ack(await f.next("completion"));
  assert.equal((await second).status, 200);
  const ledger = f.ledger();
  assert.deepEqual(ledger.map(row => row.kind), ["request", "decision", "completion", "ack", "request", "decision", "completion", "ack"]);
  assert.ok(ledger.every(row => !JSON.stringify(row).includes("provider-only")));
});

test("provider methods classify reads and writes consistently across all eight twins", () => {
  const operations = [
    ["/gmail/gmail/v1/users/me/messages", "GET", 1],
    ["/gmail/gmail/v1/users/me/messages/send", "POST", 2],
    ["/slack/api/conversations.history", "POST", 1],
    ["/slack/api/chat.postMessage", "GET", 2],
    ["/slack/api/reactions.add", "GET", 2],
    ["/calendar/calendar/v3/freeBusy", "POST", 1],
    ["/calendar/calendar/v3/calendars/primary/events/e1", "DELETE", 2],
    ["/attio/v2/objects/people/records/query", "POST", 1],
    ["/attio/v2/tasks/t1", "PATCH", 2],
    ["/google-docs/v1/documents/d1", "GET", 1],
    ["/google-docs/v1/documents", "POST", 2],
    ["/google-ads/v17/customers/123/googleAds:search", "POST", 1],
    ["/google-ads/v17/customers/123/googleAds:searchStream", "POST", 1],
    ["/linkedin/rest/posts", "GET", 1],
    ["/linkedin/rest/posts/urn:li:share:123", "POST", 2],
    ["/excel/api/workbooks/book1/export?sheetId=sheet1", "GET", 1],
    ["/excel/api/workbooks/book1/rows", "POST", 2],
  ];
  for (const [resource, method, units] of operations) {
    const target = parseTarget(resource);
    assert.equal(providerRouteAllowed(target.twin, method, target.pathname), true, resource);
    assert.equal(providerOperation(target, method, {}, Buffer.alloc(0)).workUnits, units, resource);
  }
});

test("batch writes cost per item, including Slack GET parameters, and reject ambiguous or oversized batches", () => {
  const cases = [
    ["/gmail/gmail/v1/users/me/messages/batchModify", { ids: ["a", "b", "c"] }],
    ["/google-docs/v1/documents/d1:batchUpdate", { requests: [{}, {}, {}] }],
    ["/google-ads/v17/customers/123/campaignBudgets:mutate", { operations: [{}, {}, {}] }],
    ["/excel/api/workbooks/book1/cells", { changes: [{}, {}, {}] }],
    ["/slack/api/files.completeUploadExternal", { files: [{ id: "F1" }, { id: "F2" }, { id: "F3" }] }],
  ];
  for (const [resource, body] of cases) {
    const profile = providerOperation(parseTarget(resource), "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify(body)));
    assert.equal(profile.workUnits, 6, resource);
    assert.equal(profile.items, 3);
  }
  assert.equal(providerOperation(parseTarget("/slack/api/conversations.invite?users=U1,U2,U3"), "GET", {}, Buffer.alloc(0)).workUnits, 6);
  const target = parseTarget("/slack/api/files.completeUploadExternal");
  assert.equal(providerOperation(target, "POST", { "content-type": "application/x-www-form-urlencoded" }, Buffer.from(new URLSearchParams({ files: '[{"id":"F1"},{"id":"F2"}]' }).toString())).workUnits, 4);
  for (const value of [[], {}, Array(MAX_BATCH_ITEMS + 1).fill({})]) {
    assert.throws(() => providerOperation(target, "POST", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ files: value }))));
  }
  assert.throws(() => providerOperation(parseTarget("/slack/api/conversations.invite?users=U1&users=U2"), "GET", {}, Buffer.alloc(0)));
  assert.throws(() => providerOperation(parseTarget("/slack/api/conversations.invite?users=U1"), "POST", { "content-type": "application/json" }, Buffer.from('{"users":"U2"}')));
});

test("controller endpoints require their separate credential and cannot be reached through provider routes", async t => {
  const f = await fixture(t);
  for (const headers of [{}, { authorization: "Bearer provider-only" }, { authorization: `Bearer ${TOKEN}wrong` }]) {
    assert.equal((await request(f.controlOrigin, "/next", { headers })).status, 403);
  }
  for (const resource of ["/next", "/decision", "/close", "/slack/api/sandbox/reset", "/slack/api/%2e%2e/sandbox/reset"]) {
    assert.equal((await request(f.origin, resource, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 403);
  }
  assert.equal((await request(f.origin, "/slack/api/chat.postMessage", { headers: { "x-sonata-work-units": "0" } })).status, 403);
  assert.equal(f.received.length, 0);
});

test("a rejected deadline action is never sent and still waits for completion acknowledgement", async t => {
  const f = await fixture(t);
  let returned = false;
  const pending = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body: { text: "too late" } }).then(value => { returned = true; return value; });
  const action = await f.next("request");
  assert.equal((await f.control("/decision", { actionId: action.actionId, accepted: false })).status, 200);
  const completion = await f.next("completion");
  assert.equal(completion.dispatched, false);
  assert.equal(completion.status, 409);
  assert.equal(returned, false);
  assert.equal(f.received.length, 0);
  await f.ack(completion);
  assert.equal((await pending).status, 409);
});

test("closing before decision is fail closed and a natural-end rejection is idempotent", async t => {
  const f = await fixture(t);
  const pending = request(f.origin, "/excel/api/workbooks/book1");
  const action = await f.next("request");
  assert.deepEqual((await f.control("/close", {})).data, { closed: true, drained: true });
  assert.equal((await f.control("/decision", { actionId: action.actionId, accepted: false })).status, 200);
  assert.equal((await f.control("/decision", { actionId: action.actionId, accepted: true })).status, 409);
  assert.equal((await pending).status, 409);
  assert.equal((await request(f.origin, "/excel/api/workbooks/book1")).status, 409);
  assert.equal(f.received.length, 0);
  assert.deepEqual(await f.next("closed"), { kind: "closed" });
});

test("close drains an admitted mutation and its audit acknowledgement while rejecting queued work", async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { handler: async (_req, res) => {
    started.resolve(); await release.promise;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  } });
  const first = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body: { text: "committed" } });
  const action = await f.next("request");
  await f.control("/decision", { actionId: action.actionId, accepted: true });
  await started.promise;
  const queued = request(f.origin, "/excel/api/workbooks/book1");
  const closing = await f.control("/close", {});
  assert.equal(closing.data.drained, false);
  assert.equal(closing.data.activeActionId, action.actionId);
  assert.equal((await queued).status, 409);
  release.resolve();
  const completion = await f.next("completion");
  assert.equal((await f.control("/close", {})).data.drained, false);
  await f.ack(completion);
  assert.equal((await first).status, 200);
  assert.equal((await f.control("/close", {})).data.drained, true);
  assert.equal(f.received.length, 1);
  assert.deepEqual(await f.next("closed"), { kind: "closed" });
});

test("controller disappearance before admission never executes a request", async t => {
  const f = await fixture(t, { timing: { controllerTimeoutMs: 40 } });
  const pending = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body: { text: "blocked" } });
  await f.next("request");
  assert.equal((await pending).status, 409);
  assert.equal(f.received.length, 0);
  assert.match((await f.next("closed")).fault, /controller/);
  assert.equal((await request(f.origin, "/excel/api/workbooks/book1")).status, 409);
});

test("lost audit acknowledgement after close is bounded and reported as a fault", async t => {
  const f = await fixture(t, { timing: { controllerTimeoutMs: 50 } });
  const pending = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body: { text: "already written" } });
  const action = await f.next("request");
  await f.control("/decision", { actionId: action.actionId, accepted: true });
  await f.next("completion");
  await f.control("/close", {});
  assert.equal((await pending).status, 503);
  assert.equal(f.received.length, 1);
  assert.match((await f.next("closed")).fault, /acknowledgement/);
});

test("provider failures are completion events and cannot unlock the next action without acknowledgement", async t => {
  const f = await fixture(t, { upstreamTimeoutMs: 30, handler: () => {} });
  const pending = request(f.origin, "/slack/api/chat.postMessage", { method: "POST", body: { text: "timeout" } });
  const action = await f.next("request");
  await f.control("/decision", { actionId: action.actionId, accepted: true });
  const completion = await f.next("completion");
  assert.equal(completion.dispatched, true);
  assert.equal(completion.outcome, "provider_error");
  assert.equal(completion.status, 502);
  await f.ack(completion);
  assert.equal((await pending).status, 502);
});

test("OAuth refresh is zero-unit maintenance with a separate finite budget", async t => {
  const f = await fixture(t, { timing: { maxMaintenance: 1 } });
  const options = { method: "POST", body: { grant_type: "refresh_token", refresh_token: "private-refresh-token" } };
  const pending = request(f.origin, "/gmail/oauth/token", options);
  const action = await f.next("request");
  assert.equal(action.workUnits, 0);
  assert.equal(action.classification, "maintenance");
  await f.control("/decision", { actionId: action.actionId, accepted: true });
  await f.ack(await f.next("completion"));
  assert.equal((await pending).status, 200);
  assert.equal((await request(f.origin, "/gmail/oauth/token", options)).status, 429);
  assert.equal(f.received.length, 1);
  assert.ok(f.ledger().every(event => !JSON.stringify(event).includes("private-refresh-token")));
});

test("a wall-clock safety deadline and persistent ledger failure both close without dispatch", async t => {
  const deadline = await fixture(t, { timing: { deadline: Date.now() + 60 } });
  const pending = request(deadline.origin, "/excel/api/workbooks/book1");
  assert.equal((await pending).status, 409);
  assert.equal(deadline.received.length, 0);
  assert.match((await deadline.next("closed")).fault, /deadline/);
  const failedLedger = await fixture(t, { timing: { ledgerPath: "/nonexistent-sonata-parent/provider-operations.jsonl" }, ledger: false });
  assert.equal((await request(failedLedger.origin, "/excel/api/workbooks/book1")).status, 409);
  assert.equal(failedLedger.received.length, 0);
  assert.match((await failedLedger.next("closed")).fault, /ledger/);
});

test("adding provider latency changes wall duration but not admitted units or sequence", async t => {
  const traces = [];
  for (const lag of [0, 25]) {
    const f = await fixture(t, { handler: async (_req, res) => {
      await delay(lag); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
    } });
    const trace = [];
    for (const [resource, options] of [["/excel/api/workbooks/book1", {}], ["/excel/api/workbooks/book1/cells", { method: "PATCH", body: { changes: [{ rowId: "r1" }, { rowId: "r2" }] } }]]) {
      await delay(lag); // Stand-in for model response latency, outside simulated time.
      const pending = request(f.origin, resource, options);
      const action = await f.next("request");
      trace.push({ operation: action.operation, workUnits: action.workUnits, bodySha256: action.bodySha256 });
      await f.control("/decision", { actionId: action.actionId, accepted: true });
      await f.ack(await f.next("completion"));
      assert.equal((await pending).status, 200);
    }
    traces.push(trace);
  }
  assert.deepEqual(traces[0], traces[1]);
  assert.deepEqual(traces[0].map(row => row.workUnits), [1, 4]);
});
