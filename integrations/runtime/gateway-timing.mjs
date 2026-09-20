import http from "node:http";
import { appendFileSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { TimingError, validateTimingPolicy } from "./gateway-profile.mjs";

const json = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
};

function positive(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("Invalid timing controller limit.");
  return value;
}

/**
 * One trusted admission state machine per workplace. The controller only chooses
 * whether a frozen request can proceed; it cannot change its target or payload.
 */
export function createTimingController(config) {
  const policy = validateTimingPolicy(config);
  if (typeof config.token !== "string" || config.token.length < 32) throw new Error("A separate timing control credential is required.");
  const token = Buffer.from(`Bearer ${config.token}`);
  const timeoutMs = positive(config.controllerTimeoutMs, 120_000, 120_000);
  const pollMs = positive(config.pollTimeoutMs, 10_000, 10_000);
  const maxRequests = positive(config.maxRequests, 10_000, 100_000);
  const maxMaintenance = positive(config.maxMaintenance, 64, 1_000);
  const deadline = config.deadline;
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 1)) throw new Error("Invalid timing deadline.");
  const queue = [];
  const cancelledActionIds = new Set();
  let active;
  let poll;
  let phaseTimer;
  let deadlineTimer;
  let closed = false;
  let fault;
  let count = 0;
  let maintenance = 0;

  function record(event) {
    try {
      if (config.ledgerPath) appendFileSync(config.ledgerPath, `${JSON.stringify({ ...event, recordedAt: Date.now(), policy: policy.policy })}\n`, { mode: 0o600 });
    } catch {
      close("The provider timing ledger could not be written.", true);
      throw new TimingError("The provider timing ledger could not be written.");
    }
  }
  function state() {
    return { closed, drained: !active && !queue.length, ...(active ? { activeActionId: active.actionId } : {}), ...(fault ? { fault } : {}) };
  }
  function event() {
    if (active?.event) return active.event;
    if (closed && !active) return { kind: "closed", ...(fault ? { fault } : {}) };
  }
  function notify() {
    const value = event();
    if (poll && value) {
      const waiting = poll;
      poll = undefined;
      clearTimeout(waiting.timer);
      json(waiting.res, 200, value);
    }
  }
  function close(reason, skipRecord = false) {
    closed = true;
    if (reason && !fault) fault = reason;
    if (fault || active?.phase === "request") clearTimeout(phaseTimer);
    for (const task of queue.splice(0)) task.reject(new TimingError("The provider work period has closed.", 409));
    if (active?.phase === "request") {
      const task = active;
      cancelledActionIds.add(task.actionId);
      active = undefined;
      task.reject(new TimingError("The provider work period has closed.", 409));
      if (!skipRecord) {
        try { record({ kind: "cancelled", ...task.descriptor, actionId: task.actionId, dispatched: false }); } catch { /* close already failed closed */ }
      }
    } else if (active?.phase === "completion" && fault) {
      // An unacknowledged result is never released as successful work.
      active.reject(new TimingError("Provider evidence was not acknowledged."));
      active = undefined;
    }
    if (!active) clearTimeout(deadlineTimer);
    if (!skipRecord) {
      try { record({ kind: reason ? "fault" : "closed", ...state() }); } catch { /* fault is part of state */ }
    }
    notify();
    return state();
  }
  function phaseDeadline() {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => close("Timing controller did not complete admission or evidence acknowledgement within its limit."), timeoutMs);
    phaseTimer.unref();
  }
  function nextTask() {
    if (active || closed || !queue.length) { notify(); return; }
    active = queue.shift();
    active.phase = "request";
    active.event = { kind: "request", actionId: active.actionId, ...active.descriptor };
    record(active.event);
    phaseDeadline();
    notify();
  }
  function submit(descriptor, execute, connected) {
    if (deadline !== undefined && Date.now() >= deadline) close("The workplace wall-clock safety deadline was exhausted.");
    if (closed) return Promise.reject(new TimingError("The provider work period has closed.", 409));
    if (queue.length + Number(Boolean(active)) >= 32) return Promise.reject(new TimingError("The provider action queue is full."));
    if (++count > maxRequests || (descriptor.classification === "maintenance" && ++maintenance > maxMaintenance)) {
      close("The provider request or authentication maintenance budget was exhausted.");
      return Promise.reject(new TimingError("The provider request budget has been exhausted.", 429));
    }
    return new Promise((resolve, reject) => {
      queue.push({ actionId: randomUUID(), descriptor: Object.freeze({ ...descriptor }), execute, connected, resolve, reject });
      nextTask();
    });
  }
  async function execute(task, accepted) {
    task.phase = "executing";
    task.event = undefined;
    clearTimeout(phaseTimer);
    task.dispatched = accepted && task.connected();
    try {
      if (!task.dispatched) throw new TimingError(accepted ? "The agent disconnected before admission." : "The action would exceed the work period.", accepted ? 499 : 409);
      task.response = await task.execute();
      task.result = { status: task.response.status, outcome: "response" };
    } catch (error) {
      task.error = error;
      task.result = { status: Number.isInteger(error?.status) ? error.status : 502, outcome: task.dispatched ? "provider_error" : "rejected" };
    }
    task.phase = "completion";
    task.event = { kind: "completion", actionId: task.actionId, ...task.descriptor, dispatched: task.dispatched, ...task.result };
    record(task.event);
    if (fault) {
      task.reject(new TimingError("The timing controller failed; retained provider evidence is incomplete."));
      active = undefined;
    } else phaseDeadline();
    notify();
  }
  async function readCommand(req) {
    if (String(req.headers["content-type"] ?? "").split(";")[0] !== "application/json") throw new TimingError("JSON control commands are required.", 400);
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 4_096) throw new TimingError("Control command is too large.", 413);
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
      return value;
    } catch { throw new TimingError("Invalid control command.", 400); }
  }
  const server = http.createServer({ maxHeaderSize: 8_192 }, async (req, res) => {
    try {
      const supplied = Buffer.from(String(req.headers.authorization ?? ""));
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) throw new TimingError("Timing control authorization required.", 403);
      if (req.method === "GET" && req.url === "/next") {
        if (poll) throw new TimingError("Only one timing event consumer is allowed.", 409);
        const value = event();
        if (value) json(res, 200, value);
        else {
          const waiting = { res, timer: undefined };
          waiting.timer = setTimeout(() => { if (poll === waiting) { poll = undefined; json(res, 204); } }, pollMs);
          poll = waiting;
          res.once("close", () => { if (poll === waiting) { clearTimeout(waiting.timer); poll = undefined; } });
        }
        return;
      }
      if (req.method !== "POST" || !["/decision", "/ack", "/close"].includes(req.url)) throw new TimingError("Unknown timing control command.", 404);
      const command = await readCommand(req);
      if (req.url === "/close") { json(res, 200, close()); return; }
      if (req.url === "/decision" && command.accepted === false && cancelledActionIds.has(command.actionId)) {
        // Natural end can close admission while the engine is returning its
        // rejection. This retry cannot authorize or dispatch anything.
        json(res, 200, { ok: true, closed: true }); return;
      }
      if (typeof command.actionId !== "string" || command.actionId !== active?.actionId) throw new TimingError("This action is not current.", 409);
      if (req.url === "/decision") {
        if (active.phase !== "request" || typeof command.accepted !== "boolean") throw new TimingError("This action is not awaiting a decision.", 409);
        record({ kind: "decision", actionId: active.actionId, accepted: command.accepted });
        void execute(active, command.accepted).catch(error => close(`Timing evidence could not be retained: ${error.message}`));
        json(res, 200, { ok: true });
      } else {
        if (active.phase !== "completion") throw new TimingError("This action is not awaiting acknowledgement.", 409);
        record({ kind: "ack", actionId: active.actionId });
        clearTimeout(phaseTimer);
        const task = active;
        active = undefined;
        if (closed) clearTimeout(deadlineTimer);
        if (task.error) task.reject(task.error);
        else task.resolve(task.response);
        json(res, 200, { ok: true });
        nextTask();
      }
    } catch (error) {
      json(res, error instanceof TimingError ? error.status : 500, { error: error instanceof TimingError ? error.message : "Timing controller failed." });
      if (!(error instanceof TimingError)) close("Timing evidence could not be retained.");
    }
  });
  const refuse = (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  server.on("connect", refuse);
  server.on("upgrade", refuse);
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  if (deadline !== undefined) {
    deadlineTimer = setTimeout(() => close("The workplace wall-clock safety deadline was exhausted."), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref();
  }
  return {
    server, submit, state, close,
    dispose() {
      clearTimeout(deadlineTimer);
      clearTimeout(phaseTimer);
      if (!closed || active || queue.length) close("The timing controller stopped.");
      if (poll) { clearTimeout(poll.timer); json(poll.res, 503, { error: "Timing controller stopped." }); poll = undefined; }
      server.closeAllConnections();
      server.close();
    },
  };
}
