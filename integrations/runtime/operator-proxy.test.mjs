import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { startOperatorProxy } from "./operator-proxy.mjs";

async function fixture(t) {
  const received = [];
  const backendSockets = new Set();
  const apps = ["gmail", "slack"].map((name) => {
    const app = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ name, path: req.url, headers: req.headers });
      if (req.url === "/oauth/login") {
        res.writeHead(302, { location: `http://${req.headers["x-forwarded-host"]}/oauth/callback`, "set-cookie": "gm_session=opaque; HttpOnly; SameSite=Lax" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    app.on("connection", (socket) => { backendSockets.add(socket); socket.on("close", () => backendSockets.delete(socket)); });
    app.on("upgrade", (req, socket, head) => {
      received.push({ name, path: req.url, headers: req.headers });
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nserver-ready");
      if (head.length) socket.write(head);
      socket.on("data", (data) => socket.write(data));
    });
    return app;
  });
  for (const app of apps) { app.listen(0, "127.0.0.1"); await once(app, "listening"); }
  const proxy = await startOperatorProxy({ listenHost: "127.0.0.1", listeners: apps.map((app) => ({ port: 0, upstream: `http://127.0.0.1:${app.address().port}` })) });
  const ports = proxy.servers.map((server) => server.address().port);
  t.after(async () => {
    await proxy.close();
    for (const socket of backendSockets) socket.destroy();
    await Promise.all(apps.map((app) => new Promise((resolve) => app.close(resolve))));
  });
  return { ports, received, proxy, apps, backendSockets };
}

function request(port, path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { ...headers, "content-length": Buffer.byteLength(body) } }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.once("error", reject); req.end(body);
  });
}

test("each operator listener reaches only its fixed app, retaining local UI and control requests", async (t) => {
  const { ports } = await fixture(t);
  const first = await request(ports[0], "/api/sandbox/snapshot?url=http%3A%2F%2Fslack%3A3000", { method: "POST", headers: { authorization: "Bearer operator-credential", "x-sandbox-token": "operator-credential", cookie: "gm_session=opaque", "content-type": "application/json" }, body: '{"hello":"world"}' });
  assert.equal(first.status, 200);
  const one = JSON.parse(first.body);
  assert.equal(one.name, "gmail");
  assert.equal(one.method, "POST");
  assert.equal(one.headers.authorization, "Bearer operator-credential");
  assert.equal(one.headers["x-sandbox-token"], "operator-credential");
  assert.equal(one.headers.cookie, "gm_session=opaque");
  assert.equal(one.body, '{"hello":"world"}');
  assert.equal(JSON.parse((await request(ports[1], "/api/ui/sidebar")).body).name, "slack");
});

test("public Host and forwarding values preserve OAuth callbacks without trusting forwarding overrides", async (t) => {
  const { ports } = await fixture(t);
  const host = `localhost:${ports[0]}`;
  const res = await request(ports[0], "/api/health", { headers: { host, "x-forwarded-host": "evil.test", "x-forwarded-proto": "https", "x-forwarded-port": "999", "x-forwarded-for": "attacker", forwarded: "host=evil.test" } });
  const value = JSON.parse(res.body);
  assert.equal(value.headers.host, host);
  assert.equal(value.headers["x-forwarded-host"], host);
  assert.equal(value.headers["x-forwarded-proto"], "http");
  assert.equal(value.headers["x-forwarded-port"], String(ports[0]));
  assert.notEqual(value.headers["x-forwarded-for"], "attacker");
  assert.equal(value.headers.forwarded, undefined);
  const login = await request(ports[0], "/oauth/login", { headers: { host } });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, `http://${host}/oauth/callback`);
  assert.deepEqual(login.headers["set-cookie"], ["gm_session=opaque; HttpOnly; SameSite=Lax"]);
});

test("absolute targets, protocol tunnels and invalid Host values cannot select an upstream", async (t) => {
  const { ports, received } = await fixture(t);
  for (const path of ["http://platform:3000/api/settings", "//platform:3000/api/settings", "/\\platform/api/settings"]) assert.equal((await request(ports[0], path)).status, 400);
  assert.equal((await request(ports[0], "/api/health", { headers: { host: "user@platform:3000" } })).status, 400);
  const socket = net.connect(ports[0], "127.0.0.1");
  await once(socket, "connect");
  socket.write("CONNECT platform:3000 HTTP/1.1\r\nHost: platform:3000\r\n\r\n");
  const [bytes] = await once(socket, "data");
  assert.match(bytes.toString(), /^HTTP\/1\.1 403 Forbidden/);
  socket.destroy();
  assert.equal(received.length, 0);
});

test("Next HMR upgrades retain public host, relay both directions, and close with the operator proxy", async (t) => {
  const { ports, received, proxy } = await fixture(t);
  const socket = net.connect(ports[0], "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET /_next/webpack-hmr HTTP/1.1\r\nHost: localhost:${ports[0]}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nclient-head`);
  let bytes = "";
  while (!bytes.includes("client-head")) bytes += (await once(socket, "data"))[0].toString();
  assert.match(bytes, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.ok(bytes.includes("server-ready"));
  assert.equal(received[0].name, "gmail");
  assert.equal(received[0].path, "/_next/webpack-hmr");
  assert.equal(received[0].headers["x-forwarded-host"], `localhost:${ports[0]}`);
  socket.write("client-message");
  assert.equal((await once(socket, "data"))[0].toString(), "client-message");
  const closed = once(socket, "close");
  await proxy.close();
  await closed;
  await assert.rejects(request(ports[0], "/api/health"), /ECONNREFUSED/);
});

test("invalid listener configs fail before opening a port and partial startup rolls back", async (t) => {
  for (const config of [
    { listeners: [] }, { listeners: [{ port: 1234, upstream: "http://secret@app:3000" }] },
    { listeners: [{ port: 1234, upstream: "http://app:3000/api" }] },
    { listeners: [{ port: 1234, upstream: "https://app:3000" }] },
    { listeners: [{ port: -1, upstream: "http://app:3000" }] },
    { listeners: [{ port: 1234, upstream: "http://app:3000" }, { port: 1234, upstream: "http://app2:3000" }] },
  ]) await assert.rejects(startOperatorProxy(config));
  const { apps } = await fixture(t);
  const heldPort = apps[0].address().port;
  await assert.rejects(startOperatorProxy({ listenHost: "127.0.0.1", listeners: [{ port: 0, upstream: "http://app:3000" }, { port: heldPort, upstream: "http://app:3000" }] }), /EADDRINUSE/);
});
