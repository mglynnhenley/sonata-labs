#!/usr/bin/env node
/**
 * Per-workplace provider gateway. This process is the only service shared by
 * the agent and app networks. It has fixed upstreams and no control credential.
 * The caller's target is always a provider resource, never an upstream URL.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { providerOperation, TimingError } from "./gateway-profile.mjs";
import { createTimingController } from "./gateway-timing.mjs";

const TWINS = new Set(["gmail", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel"]);
const SLACK_METHODS = new Set([
  "auth.test", "users.list", "users.info", "users.counts", "users.conversations", "users.lookupByEmail",
  "users.setPresence", "users.getPresence", "team.info", "emoji.list", "conversations.list", "conversations.info",
  "conversations.history", "conversations.replies", "conversations.members", "conversations.create",
  "conversations.invite", "conversations.join", "conversations.leave", "conversations.archive",
  "conversations.unarchive", "conversations.setTopic", "conversations.setPurpose", "conversations.rename",
  "conversations.open", "conversations.mark", "chat.postMessage", "chat.update", "chat.delete", "chat.getPermalink",
  "chat.postEphemeral", "chat.scheduleMessage", "chat.deleteScheduledMessage", "chat.scheduledMessages.list",
  "reactions.get", "reactions.list", "reactions.add", "reactions.remove", "pins.list", "pins.add", "pins.remove",
  "files.list", "files.info", "files.upload", "files.getUploadURLExternal", "files.completeUploadExternal", "search.messages",
]);

// Resource segments may contain encoded email addresses and LinkedIn URNs.
// Separators, dot segments, and repeated decoding are refused before matching.
const segment = "[^/]+";
const route = (methods, expression) => [new Set(methods.split(" ")), new RegExp(`^${expression}$`)];
const gmail = `/gmail/v1/users/${segment}`;
const events = `/calendar/v3/calendars/${segment}/events`;
const ROUTES = {
  gmail: [
    route("POST", "/oauth/token"),
    route("GET", `${gmail}/(?:profile|history)`),
    route("GET", `${gmail}/(?:messages|threads)`),
    route("GET POST", `${gmail}/(?:drafts|labels)`),
    route("GET DELETE", `${gmail}/(?:messages|threads|drafts)/${segment}`),
    route("GET PATCH PUT DELETE", `${gmail}/labels/${segment}`),
    route("PUT", `${gmail}/drafts/${segment}`),
    route("POST", `${gmail}/messages/(?:send|batchDelete|batchModify)`),
    route("POST", `${gmail}/drafts/send`),
    route("POST", `${gmail}/(?:messages|threads)/${segment}/(?:modify|trash|untrash)`),
    route("GET", `${gmail}/messages/${segment}/attachments/${segment}`),
  ],
  calendar: [
    route("GET", "/calendar/v3/users/me/calendarList"),
    route("POST", "/calendar/v3/freeBusy"),
    route("GET POST", events),
    route("GET PATCH PUT DELETE", `${events}/${segment}`),
  ],
  attio: [
    route("GET", "/v2/self"),
    route("GET", `/v2/workspace_members(?:/${segment})?`),
    route("GET POST", "/v2/(?:tasks|notes)"),
    route("GET PATCH", `/v2/tasks/${segment}`),
    route("POST", `/v2/objects/${segment}/records(?:/query)?`),
    route("GET PATCH", `/v2/objects/${segment}/records/${segment}`),
  ],
  "google-docs": [
    route("POST", "/v1/documents"),
    route("GET", "/v1/documents/[^/:]+"),
    route("POST", "/v1/documents/[^/:]+:batchUpdate"),
  ],
  "google-ads": [
    route("GET", "/v[0-9]+/customers:listAccessibleCustomers"),
    route("POST", "/v[0-9]+/customers/[0-9]+/(?:googleAds:search|googleAds:searchStream|campaigns:mutate|campaignBudgets:mutate)"),
  ],
  linkedin: [
    route("GET", "/v2/userinfo"),
    route("GET", "/rest/organizationAcls"),
    route("GET", "/rest/organizations/[0-9]+"),
    route("GET POST", "/rest/posts"),
    route("GET POST DELETE", `/rest/posts/${segment}`),
    route("POST", "/rest/reactions"),
    route("GET POST", `/rest/socialActions/${segment}/comments`),
    route("GET", `/rest/socialMetadata/${segment}`),
  ],
  excel: [
    route("GET", "/api/workbooks"),
    route("GET", `/api/workbooks/${segment}(?:/(?:history|export))?`),
    route("PATCH", `/api/workbooks/${segment}/cells`),
    route("POST", `/api/workbooks/${segment}/rows`),
  ],
};

export function providerRouteAllowed(twin, method, pathname) {
  if (twin === "slack") {
    if (method === "POST" && /^\/api\/uploads\/F[A-Z0-9]+$/.test(pathname)) return true;
    return (method === "GET" || method === "POST") && SLACK_METHODS.has(pathname.replace(/^\/api\//, "")) && pathname.startsWith("/api/");
  }
  return ROUTES[twin]?.some(([methods, pattern]) => methods.has(method) && pattern.test(pathname)) ?? false;
}

class PolicyError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

/** Decode once for policy, then build a fresh canonical request path. */
export function parseTarget(rawTarget) {
  if (typeof rawTarget !== "string" || !rawTarget.startsWith("/") || rawTarget.startsWith("//") || /[\\#\u0000-\u0020\u007f]/.test(rawTarget)) {
    throw new PolicyError("Only provider resource paths are allowed.");
  }
  const question = rawTarget.indexOf("?");
  const path = question === -1 ? rawTarget : rawTarget.slice(0, question);
  let parts;
  try { parts = path.slice(1).split("/").map(decodeURIComponent); }
  catch { throw new PolicyError("Malformed provider resource path."); }
  if (parts.some((part) => !part || part === "." || part === ".." || /[/\\%\u0000-\u001f\u007f]/.test(part))) {
    throw new PolicyError("Ambiguous provider resource path.");
  }
  const twin = parts.shift();
  const pathname = `/${parts.join("/")}`;
  const query = new URLSearchParams(question === -1 ? "" : rawTarget.slice(question + 1));
  const encoded = parts.map((part) => encodeURIComponent(part).replace(/%3A/gi, ":")).join("/");
  return { twin, pathname, query, path: `/${encoded}${query.size ? `?${query.toString()}` : ""}` };
}

const REQUEST_HEADERS = new Set([
  "authorization", "accept", "accept-language", "content-type", "user-agent", "range", "if-range", "if-match",
  "if-none-match", "if-modified-since", "if-unmodified-since", "developer-token", "login-customer-id",
  "linked-customer-id", "linkedin-version", "x-restli-protocol-version", "x-restli-method", "x-goog-api-client",
]);
const RESPONSE_HEADERS = new Set([
  "content-type", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified", "cache-control",
  "pragma", "retry-after", "www-authenticate", "x-restli-id", "x-restli-protocol-version", "x-slack-req-id",
  "x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
]);

function cleanRequestHeaders(headers) {
  if (Object.keys(headers).some((name) => name.startsWith("x-sandbox-") || name.startsWith("x-sonata-"))) {
    throw new PolicyError("Control headers are unavailable on the provider gateway.");
  }
  const nominated = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((name) => name.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => REQUEST_HEADERS.has(name) && !nominated.has(name)));
}

async function readBounded(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new PolicyError("Provider payload exceeds the workplace limit.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateRefresh(headers, body, query) {
  if (query.size) throw new PolicyError("OAuth refresh parameters belong in the request body.");
  const type = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  let values;
  try {
    if (type === "application/json") {
      const parsed = JSON.parse(body.toString("utf8"));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      values = parsed;
    } else if (type === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(body.toString("utf8"));
      if ([...form.keys()].some((key) => form.getAll(key).length !== 1)) throw new Error();
      values = Object.fromEntries(form);
    } else throw new Error();
  } catch { throw new PolicyError("Use an unambiguous JSON or form OAuth refresh request."); }
  const allowed = new Set(["grant_type", "refresh_token", "client_id", "client_secret", "scope"]);
  if (values.grant_type !== "refresh_token" || typeof values.refresh_token !== "string" || !values.refresh_token ||
      Object.entries(values).some(([key, value]) => !allowed.has(key) || typeof value !== "string")) {
    throw new PolicyError("Only an existing OAuth refresh grant is allowed.");
  }
}

function normalizeConfig(config) {
  if (!config || !config.upstreams || typeof config.upstreams !== "object" || Array.isArray(config.upstreams)) throw new Error("Gateway upstreams are required.");
  const upstreams = new Map();
  for (const [twin, address] of Object.entries(config.upstreams)) {
    const url = new URL(address);
    if (!TWINS.has(twin) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Invalid fixed gateway upstream for ${twin}.`);
    }
    upstreams.set(twin, url);
  }
  if (!upstreams.size) throw new Error("At least one fixed gateway upstream is required.");
  const publicUrl = new URL(config.publicOrigin ?? "http://gateway:8080");
  if (publicUrl.protocol !== "http:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("Invalid gateway public origin.");
  return { upstreams, publicOrigin: publicUrl.origin };
}

function rewriteProviderBody(target, body, headers, publicOrigin) {
  const slackUpload = target.twin === "slack" && target.pathname === "/api/files.getUploadURLExternal";
  const linkedIn = target.twin === "linkedin";
  if (!slackUpload && !linkedIn) return body;
  if (!String(headers["content-type"] ?? "").includes("application/json") || !body.length) return body;
  let value;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { throw new PolicyError("Invalid provider JSON response.", 502); }
  if (slackUpload && value.ok === true) {
    if (typeof value.file_id !== "string" || !/^F[A-Z0-9]+$/.test(value.file_id)) throw new PolicyError("Invalid provider upload resource.", 502);
    // The upstream's public URL can differ from its internal Docker address.
    // Build only this known upload path from the identifier; never proxy its URL.
    value.upload_url = `${publicOrigin}/slack/api/uploads/${value.file_id}`;
  }
  if (linkedIn && Array.isArray(value?.paging?.links)) {
    for (const link of value.paging.links) {
      if (!link || typeof link.href !== "string") throw new PolicyError("Invalid provider pagination link.", 502);
      let next;
      try { next = parseTarget(`/linkedin${link.href}`); }
      catch { throw new PolicyError("Invalid provider pagination destination.", 502); }
      if (!link.href.startsWith("/") || link.href.startsWith("//") || !providerRouteAllowed("linkedin", "GET", next.pathname)) {
        throw new PolicyError("Invalid provider pagination destination.", 502);
      }
      link.href = `${publicOrigin}/linkedin${next.path}`;
    }
  }
  return Buffer.from(JSON.stringify(value));
}

function replyError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const publicError = error instanceof PolicyError || error instanceof TimingError;
  const status = publicError ? error.status : 502;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: publicError ? error.message : "Workplace provider unavailable." }));
}

export function createGateway(config) {
  const { upstreams, publicOrigin } = normalizeConfig(config);
  const timing = config.timing ? createTimingController(config.timing) : undefined;
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 30_000;
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 || upstreamTimeoutMs > 30_000) throw new Error("Invalid provider timeout.");
  let pending = 0;
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (++pending > 32) { pending--; replyError(res, new PolicyError("Workplace gateway busy.", 503)); return; }
    try {
      const target = parseTarget(req.url);
      const upstream = upstreams.get(target.twin);
      if (!upstream || !providerRouteAllowed(target.twin, req.method, target.pathname)) throw new PolicyError("This provider operation is unavailable.");
      const headers = cleanRequestHeaders(req.headers);
      const body = await readBounded(req, 16 * 1024 * 1024);
      if (target.twin === "gmail" && target.pathname === "/oauth/token") validateRefresh(headers, body, target.query);
      const execute = async () => {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(new Error("Provider timed out.")), upstreamTimeoutMs);
        const cancel = () => abort.abort(new Error("Agent disconnected."));
        // Once admitted, drain the request even if the agent disconnects. The
        // controller must capture its possible effects before freezing the DBs.
        if (!timing) res.once("close", cancel);
        try {
          const upstreamResponse = await new Promise((resolve, reject) => {
            const request = http.request({
              hostname: upstream.hostname, port: upstream.port || 80, method: req.method, path: target.path,
              // Caller-supplied host, routing, control and override headers are
              // excluded. Timing admission never rewrites provider arguments.
              headers: { ...headers, host: upstream.host, "content-length": String(body.length), "accept-encoding": "identity" },
              signal: abort.signal,
            }, resolve);
            request.once("error", reject);
            request.end(body);
          });
          const status = upstreamResponse.statusCode ?? 502;
          if ((status >= 300 && status < 400 && status !== 304) || upstreamResponse.headers.location) {
            upstreamResponse.destroy();
            throw new PolicyError("Provider redirects are unavailable.", 502);
          }
          if (upstreamResponse.headers["content-encoding"] && upstreamResponse.headers["content-encoding"] !== "identity") {
            upstreamResponse.destroy();
            throw new PolicyError("Unexpected provider content encoding.", 502);
          }
          const bytes = await readBounded(upstreamResponse, 32 * 1024 * 1024);
          const output = rewriteProviderBody(target, bytes, upstreamResponse.headers, publicOrigin);
          const responseHeaders = Object.fromEntries(Object.entries(upstreamResponse.headers).filter(([name]) => RESPONSE_HEADERS.has(name)));
          return { status, headers: { ...responseHeaders, "content-length": String(output.length) }, body: output };
        } finally {
          clearTimeout(timeout);
          res.removeListener("close", cancel);
        }
      };
      const response = timing ? await timing.submit({
        ...providerOperation(target, req.method, headers, body), twin: target.twin, method: req.method, path: target.pathname,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        querySha256: createHash("sha256").update(target.query.toString()).digest("hex"),
      }, execute, () => !res.destroyed) : await execute();
      if (!res.destroyed) {
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      }
    } catch (error) { replyError(res, error); }
    finally { pending--; }
  });
  // Neither protocol gives callers a tunnel to the private backend network.
  const refuseTunnel = (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  server.on("connect", refuseTunnel);
  server.on("upgrade", refuseTunnel);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timing = timing;
  server.once("close", () => timing?.dispose());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.argv[2] ?? "/run/gateway.json", "utf8"));
  const server = createGateway(config);
  server.listen(config.port ?? 8080, config.listenHost ?? "0.0.0.0");
  server.timing?.server.listen(config.timing.controlPort ?? 8081, config.timing.listenHost ?? "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
