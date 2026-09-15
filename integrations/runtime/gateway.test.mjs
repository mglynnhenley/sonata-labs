import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createGateway } from "./gateway.mjs";

let backend;
let gateway;
let port;
let backendOrigin;
const received = [];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function request(path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { ...headers, "content-length": Buffer.byteLength(body) } }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      } catch (error) { reject(error); }
    });
    req.once("error", reject);
    req.end(body);
  });
}

function rawRequest(bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(bytes));
    const chunks = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error("Raw request timed out.")));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

before(async () => {
  backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ path: req.url, method: req.method, headers: req.headers, body });
    const query = new URL(req.url, backendOrigin).searchParams;
    const scenario = query.get("fixture");
    if (scenario === "redirect") {
      res.writeHead(307, { location: "http://platform:3000/api/settings", "set-cookie": "control=secret" });
      res.end("Hidden provider redirect");
      return;
    }
    if (scenario === "created-location") {
      res.writeHead(201, { location: "/api/sandbox/snapshot" }); res.end(); return;
    }
    if (scenario === "empty") { res.writeHead(204); res.end(); return; }
    if (scenario === "binary") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="sample.csv"' });
      res.end(Buffer.from([0, 1, 127, 128, 255])); return;
    }
    const headers = {
      "content-type": "application/json", "x-restli-id": "urn:li:share:123", "retry-after": "3",
      "set-cookie": "control=secret", "x-middleware-rewrite": "http://platform:3000/api/settings",
      refresh: "0;url=http://platform:3000/api/settings", "x-powered-by": "internal-next-version",
    };
    res.writeHead(200, headers);
    if (req.url.startsWith("/api/files.getUploadURLExternal")) {
      res.end(JSON.stringify({ ok: true, file_id: scenario === "bad-upload" ? "../sandbox/reset" : "F012AB", upload_url: "http://platform:3000/api/settings" }));
    } else if (scenario === "paging") {
      res.end(JSON.stringify({ elements: [], paging: { links: [{ rel: "next", href: "/rest/posts?q=author&start=10" }] } }));
    } else if (scenario === "bad-paging") {
      res.end(JSON.stringify({ paging: { links: [{ href: "/rest/posts/../../api/sandbox/snapshot" }] } }));
    } else {
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, headers: req.headers, body }));
    }
  });
  backendOrigin = `http://127.0.0.1:${await listen(backend)}`;
  gateway = createGateway({ upstreams: Object.fromEntries(["gmail", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel"].map((twin) => [twin, backendOrigin])), publicOrigin: "http://gateway:8080" });
  port = await listen(gateway);
});

after(async () => {
  for (const server of [gateway, backend]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("all eight provider surfaces preserve paths, methods, authentication and SDK headers", async () => {
  const operations = [
    ["gmail", "GET", "/gmail/v1/users/sam%40company.test/messages?maxResults=10&labelIds=INBOX&labelIds=UNREAD"],
    ["gmail", "POST", "/gmail/v1/users/me/messages/send"],
    ["gmail", "PUT", "/gmail/v1/users/me/drafts/d1"],
    ["gmail", "PATCH", "/gmail/v1/users/me/labels/l1"],
    ["gmail", "GET", "/gmail/v1/users/me/messages/m1/attachments/a1"],
    ["slack", "POST", "/api/chat.postMessage"],
    ["slack", "GET", "/api/conversations.history?channel=C0123"],
    ["slack", "POST", "/api/files.upload"],
    ["calendar", "GET", "/calendar/v3/users/me/calendarList"],
    ["calendar", "POST", "/calendar/v3/calendars/me%40example.test/events"],
    ["calendar", "DELETE", "/calendar/v3/calendars/primary/events/event1"],
    ["attio", "GET", "/v2/self"],
    ["attio", "POST", "/v2/objects/people/records/query"],
    ["attio", "PATCH", "/v2/objects/companies/records/r1"],
    ["attio", "POST", "/v2/notes"],
    ["attio", "PATCH", "/v2/tasks/t1"],
    ["google-docs", "GET", "/v1/documents/doc1"],
    ["google-docs", "POST", "/v1/documents/doc1:batchUpdate"],
    ["google-ads", "GET", "/v17/customers:listAccessibleCustomers"],
    ["google-ads", "POST", "/v17/customers/123/googleAds:search"],
    ["google-ads", "POST", "/v17/customers/123/campaignBudgets:mutate"],
    ["linkedin", "GET", "/rest/posts/urn%3Ali%3Ashare%3A123"],
    ["linkedin", "POST", "/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A123%2C456%29/comments"],
    ["linkedin", "POST", "/rest/posts/urn:li:share:123"],
    ["excel", "GET", "/api/workbooks/book1?original=1"],
    ["excel", "PATCH", "/api/workbooks/book1/cells"],
    ["excel", "POST", "/api/workbooks/book1/rows"],
    ["excel", "GET", "/api/workbooks/book1/history"],
    ["excel", "GET", "/api/workbooks/book1/export?sheetId=sheet1"],
  ];
  for (const [twin, method, path] of operations) {
    const res = await request(`/${twin}${path}`, { method, headers: { authorization: "Bearer agent-only", "content-type": "application/json", "developer-token": "developer", "linkedin-version": "202506", "x-restli-method": "PARTIAL_UPDATE" }, body: method === "POST" || method === "PATCH" ? '{"text":"hello"}' : "" });
    assert.equal(res.status, 200, `${method} ${twin}${path}: ${res.body}`);
    const data = JSON.parse(res.body);
    assert.equal(data.method, method);
    assert.equal(data.headers.authorization, "Bearer agent-only");
    assert.equal(data.headers["developer-token"], "developer");
    assert.equal(data.headers["linkedin-version"], "202506");
    assert.equal(data.headers["x-restli-method"], "PARTIAL_UPDATE");
  }
});

test("control, UI, platform and unconfigured operations never reach a backend even with a control credential", async () => {
  const paths = [
    "/gmail/api/sandbox/token", "/gmail/api/sandbox/seed", "/gmail/api/eval/runs", "/gmail/api/health",
    "/gmail/oauth/authorize", "/gmail/oauth/authorize/decision", "/slack/api/activity", "/slack/api/sandbox/events",
    "/slack/api/ui/sidebar", "/slack/api/health", "/excel/api/ui/workbooks", "/excel/api/sandbox/snapshot",
    "/calendar/api/ui/calendars", "/attio/api/ui/v2/self", "/linkedin/api/sandbox/reset",
    "/google-docs/api/sandbox/snapshot", "/google-ads/api/health", "/platform/api/settings", "/gmail-ui/api/ui/list",
    "/slack/_next/static/secret", "/slack/api/unknown.method", "/attio/v2/admin", "/api/settings",
  ];
  const before = received.length;
  for (const path of paths) {
    for (const method of ["GET", "POST"]) {
      assert.equal((await request(path, { method, headers: { authorization: "Bearer real-control-secret" } })).status, 403, `${method} ${path}`);
    }
  }
  assert.equal(received.length, before);
});

test("path normalization, encoded separators and absolute targets cannot escape the fixed route", async () => {
  const paths = [
    "http://platform:3000/slack/api/auth.test", "//platform:3000/slack/api/auth.test",
    "/slack/api/auth.test/../../sandbox/snapshot", "/slack/api/../sandbox/reset", "/slack//api/auth.test",
    "/slack/api/%2e%2e/sandbox/snapshot", "/slack/api/%252e%252e/sandbox/reset", "/slack/api/%25252e%25252e/reset",
    "/slack/api/auth.test%2f..%2f..%2fsandbox/reset", "/slack/api/auth.test%5c..%5csandbox/reset",
    "/slack/api/auth.test\\..\\sandbox/reset", "/slack/api/%00auth.test", "/slack/api/auth.test#fragment",
    "/slack/api/%ZZ", "/slack/api/auth.test/", "/slack/api/.%2e/sandbox/reset",
    "/gmail/gmail/v1/users/me/messages/%2e%2e", "/gmail/gmail/v1/users/me/messages/%252fapi%252fsandbox",
  ];
  const before = received.length;
  for (const path of paths) assert.equal((await request(path)).status, 403, path);
  assert.equal(received.length, before);
});

test("host, forwarding, Next routing and method override headers never influence the upstream", async () => {
  const res = await request("/slack/api/auth.test", { headers: {
    host: "platform:3000", "x-forwarded-host": "platform:3000", "x-forwarded-proto": "https",
    "x-original-url": "/api/settings", "x-rewrite-url": "/api/sandbox/snapshot", "x-http-method-override": "DELETE",
    "x-middleware-subrequest": "middleware:middleware", "x-middleware-rewrite": "http://platform:3000/api/settings",
    "next-action": "admin", "next-url": "/api/settings", cookie: "control=secret", origin: "http://platform:3000",
    authorization: "Bearer agent-only", connection: "keep-alive, x-restli-method", "x-restli-method": "DELETE",
  } });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.path, "/api/auth.test");
  assert.equal(data.method, "GET");
  assert.equal(data.headers.host, new URL(backendOrigin).host);
  assert.equal(data.headers.authorization, "Bearer agent-only");
  for (const key of ["x-forwarded-host", "x-original-url", "x-rewrite-url", "x-http-method-override", "x-middleware-subrequest", "x-middleware-rewrite", "next-action", "next-url", "cookie", "origin", "x-restli-method"]) assert.equal(data.headers[key], undefined, key);
  const before = received.length;
  assert.equal((await request("/slack/api/auth.test", { headers: { "x-sandbox-token": "control" } })).status, 403);
  assert.equal(received.length, before);
});

test("URLs and encoded newlines in query or provider payload are data, never proxy destinations", async () => {
  const query = new URLSearchParams({ url: "http://platform:3000/api/settings", redirect_uri: "http://169.254.169.254/latest/meta-data", target: "//other-run:3200/api/sandbox/reset", text: "hello\r\nHost: attacker.test" });
  const body = JSON.stringify({ url: "http://platform:3000/api/settings", text: "Visit https://example.test" });
  const res = await request(`/slack/api/chat.postMessage?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.headers.host, new URL(backendOrigin).host);
  assert.equal(data.path, `/api/chat.postMessage?${query}`);
  assert.equal(data.body, body);
});

test("OAuth can refresh an existing grant, but cannot authorize or exchange a code", async () => {
  for (const [contentType, body] of [
    ["application/x-www-form-urlencoded", "grant_type=refresh_token&refresh_token=refresh123&client_id=agent"],
    ["application/json", JSON.stringify({ grant_type: "refresh_token", refresh_token: "refresh123", client_id: "agent" })],
  ]) {
    const res = await request("/gmail/oauth/token", { method: "POST", headers: { "content-type": contentType }, body });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).body, body);
  }
  const before = received.length;
  for (const body of [
    "grant_type=authorization_code&code=known-code&client_id=agent",
    "grant_type=client_credentials&client_id=agent", "grant_type=refresh_token&refresh_token=r&code=known-code",
    "grant_type=refresh_token&grant_type=authorization_code&refresh_token=r",
    "grant_type=authorization_code&grant_type=refresh_token&refresh_token=r",
    "grant_type=refresh_token&refresh_token=r&redirect_uri=http://platform:3000", "grant_type=refresh_token",
  ]) assert.equal((await request("/gmail/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).status, 403, body);
  assert.equal((await request("/gmail/oauth/token?grant_type=authorization_code", { method: "POST", headers: { "content-type": "application/json" }, body: '{"grant_type":"refresh_token","refresh_token":"r"}' })).status, 403);
  assert.equal((await request("/gmail/oauth/token", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x" })).status, 403);
  assert.equal(received.length, before);
});

test("Slack external upload flow returns only its fixed gateway byte sink", async () => {
  const res = await request("/slack/api/files.getUploadURLExternal", { method: "POST", body: "filename=x.txt&length=5", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 200);
  const value = JSON.parse(res.body);
  assert.equal(value.upload_url, "http://gateway:8080/slack/api/uploads/F012AB");
  const upload = await request(new URL(value.upload_url).pathname, { method: "POST", body: "hello", headers: { "content-type": "application/octet-stream" } });
  assert.equal(upload.status, 200);
  assert.equal(JSON.parse(upload.body).path, "/api/uploads/F012AB");
  assert.equal(JSON.parse(upload.body).body, "hello");
  assert.equal((await request("/slack/api/files.completeUploadExternal", { method: "POST", body: '{"files":[{"id":"F012AB"}]}' })).status, 200);
  assert.equal((await request("/slack/api/uploads/F012AB", { method: "GET" })).status, 403);
  assert.equal((await request("/slack/api/uploads/../sandbox/reset", { method: "POST" })).status, 403);
  assert.equal((await request("/slack/api/files.getUploadURLExternal?fixture=bad-upload")).status, 502);
});

test("LinkedIn pagination uses gateway provider links and refuses hidden destinations", async () => {
  const res = await request("/linkedin/rest/posts?fixture=paging");
  assert.equal(res.status, 200);
  const href = JSON.parse(res.body).paging.links[0].href;
  assert.equal(href, "http://gateway:8080/linkedin/rest/posts?q=author&start=10");
  assert.equal((await request(`${new URL(href).pathname}${new URL(href).search}`)).status, 200);
  assert.equal((await request("/linkedin/rest/posts?fixture=bad-paging")).status, 502);
});

test("redirects and upstream browser/control response headers cannot create a tunnel", async () => {
  for (const fixture of ["redirect", "created-location"]) {
    const before = received.length;
    const res = await request(`/slack/api/auth.test?fixture=${fixture}`);
    assert.equal(res.status, 502);
    assert.equal(res.headers.location, undefined);
    assert.equal(res.headers["set-cookie"], undefined);
    assert.equal(received.length, before + 1);
    assert.ok(!res.body.includes("platform:3000"));
  }
  const res = await request("/linkedin/rest/posts");
  assert.equal(res.headers["x-restli-id"], "urn:li:share:123");
  assert.equal(res.headers["retry-after"], "3");
  for (const name of ["set-cookie", "x-middleware-rewrite", "refresh", "x-powered-by"]) assert.equal(res.headers[name], undefined, name);
});

test("CONNECT and WebSockets are refused without touching the backend", async () => {
  const before = received.length;
  for (const raw of [
    "CONNECT platform:3000 HTTP/1.1\r\nHost: platform:3000\r\n\r\n",
    "GET /slack/api/auth.test HTTP/1.1\r\nHost: gateway:8080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  ]) assert.match(await rawRequest(raw), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(received.length, before);
});

test("health has no clone metadata and unknown upstream config fails closed", async () => {
  const before = received.length;
  assert.deepEqual(JSON.parse((await request("/healthz")).body), { ok: true });
  assert.equal(received.length, before);
  for (const upstreams of [
    { platform: backendOrigin }, { slack: `${backendOrigin}/api` }, { slack: "file:///etc/passwd" },
    { slack: "http://secret@slack:3200" }, { slack: `${backendOrigin}?url=http://platform:3000` }, {},
  ]) assert.throws(() => createGateway({ upstreams }));
});

test("empty provider responses and supported download content types survive the gateway", async () => {
  const empty = await request("/calendar/calendar/v3/calendars/primary/events/e1?fixture=empty", { method: "DELETE" });
  assert.equal(empty.status, 204);
  assert.equal(empty.body, "");
  const file = await request("/excel/api/workbooks/book1/export?fixture=binary");
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "application/octet-stream");
  assert.equal(file.headers["content-disposition"], 'attachment; filename="sample.csv"');
  assert.equal(file.headers["content-length"], "5");
});
