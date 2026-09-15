#!/usr/bin/env node
/**
 * Trusted, host-published access to a private workplace's apps and browser UIs.
 * This container must NEVER join the agent network. Unlike gateway.mjs, it
 * exposes the whole app and relies on the app's existing control authentication.
 * Each listener has one fixed upstream; no request can choose another host.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";

const HOP_HEADERS = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

function parseUpstream(address) {
  const upstream = new URL(address);
  if (upstream.protocol !== "http:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("Operator listeners require a fixed HTTP upstream origin.");
  }
  return upstream;
}

function publicHost(req) {
  const value = req.headers.host;
  if (typeof value !== "string" || !/^[a-zA-Z0-9.\[\]:-]+$/.test(value)) throw new Error("Invalid public Host header.");
  const url = new URL(`http://${value}`);
  if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error("Invalid public Host header.");
  return url;
}

function validTarget(req) {
  if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || /[\\#\u0000-\u0020\u007f]/.test(req.url)) {
    throw new Error("Only app resource paths are accepted.");
  }
}

function headersFor(req, upgrade) {
  validTarget(req);
  const host = publicHost(req);
  const nominated = new Set(String(req.headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()));
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name) && !nominated.has(name)));
  headers.host = host.host;
  headers["x-forwarded-host"] = host.host;
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-port"] = host.port || "80";
  headers["x-forwarded-for"] = req.socket.remoteAddress || "";
  delete headers.forwarded;
  if (upgrade) { headers.connection = "Upgrade"; headers.upgrade = "websocket"; }
  return headers;
}

function bounded(limit) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error("Operator proxy payload limit exceeded.") : null, chunk);
  } });
}

function failResponse(res, status) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: status === 400 ? "Invalid app request." : "Workplace app unavailable." }));
}

function socketResponse(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createListener(upstream) {
  const sockets = new Set();
  const upstreamSockets = new Set();
  const server = http.createServer({ maxHeaderSize: 32 * 1024 }, (req, res) => {
    let headers;
    try { headers = headersFor(req, false); }
    catch { failResponse(res, 400); return; }
    const request = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: req.method, path: req.url, headers, timeout: 60_000 }, (response) => {
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      const output = bounded(256 * 1024 * 1024);
      response.once("error", () => res.destroy());
      output.once("error", () => { response.destroy(); res.destroy(); });
      response.pipe(output).pipe(res);
    });
    request.once("socket", (socket) => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
    request.once("timeout", () => request.destroy(new Error("App request timed out.")));
    request.once("error", () => failResponse(res, 502));
    const input = bounded(64 * 1024 * 1024);
    input.once("error", () => { request.destroy(); failResponse(res, 413); });
    req.once("aborted", () => request.destroy());
    res.once("close", () => request.destroy());
    req.pipe(input).pipe(request);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (_req, socket) => socketResponse(socket, 403));
  server.on("upgrade", (req, socket, head) => {
    let headers;
    try {
      if (String(req.headers.upgrade).toLowerCase() !== "websocket") throw new Error();
      headers = headersFor(req, true);
    } catch { socketResponse(socket, 403); return; }
    const request = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: req.method, path: req.url, headers, timeout: 30_000 });
    request.once("socket", (remote) => { upstreamSockets.add(remote); remote.once("close", () => upstreamSockets.delete(remote)); });
    request.once("timeout", () => request.destroy(new Error("App upgrade timed out.")));
    request.once("error", () => socketResponse(socket, 502));
    request.once("response", (response) => {
      response.resume();
      socketResponse(socket, 502);
    });
    request.once("upgrade", (response, remote, remoteHead) => {
      remote.setTimeout(0);
      upstreamSockets.add(remote);
      remote.once("close", () => { upstreamSockets.delete(remote); socket.destroy(); });
      remote.once("error", () => socket.destroy());
      socket.once("close", () => remote.destroy());
      const lines = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    socket.once("close", () => request.destroy());
    request.end();
  });
  server.maxConnections = 128;
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    async close() {
      for (const socket of [...sockets, ...upstreamSockets]) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function startOperatorProxy(config) {
  if (!Array.isArray(config?.listeners) || !config.listeners.length) throw new Error("At least one operator listener is required.");
  const ports = new Set();
  const settings = config.listeners.map(({ port, upstream }) => {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && ports.has(port))) throw new Error("Each operator listener needs a unique valid port.");
    ports.add(port);
    return { port, upstream: parseUpstream(upstream) };
  });
  const listeners = [];
  try {
    for (const setting of settings) {
      const listener = createListener(setting.upstream);
      listeners.push(listener);
      listener.server.listen(setting.port, config.listenHost ?? "0.0.0.0");
      await once(listener.server, "listening");
    }
  } catch (error) { await Promise.all(listeners.map((listener) => listener.close())); throw error; }
  return { servers: listeners.map((listener) => listener.server), close: () => Promise.all(listeners.map((listener) => listener.close())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = await startOperatorProxy(JSON.parse(readFileSync(process.argv[2] ?? "/config.json", "utf8")));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    void proxy.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
