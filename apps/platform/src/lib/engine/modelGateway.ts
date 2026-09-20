import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ModelGatewaySpend { usd: number; calls: number; unpriced: number }
export interface ModelGatewayOptions {
  runId: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxCostUsd?: number;
  /** Other roles' captured spend; agent spend is maintained by this gateway. */
  getOtherCost?: () => Pick<ModelGatewaySpend, "usd" | "unpriced">;
  onLimit?: (reason: string) => void;
  maxTokens?: number;
  timeoutMs?: number;
}
export interface ModelGateway {
  /** OpenAI-compatible API root, including /v1. */
  url: string;
  token: string;
  spend(): ModelGatewaySpend;
  stop(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { message, type: "sonata_model_gateway" } }));
}
async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request exceeds the model gateway body limit.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON request object.");
  return value as Record<string, unknown>;
}

/**
 * The fixed Inspect harness receives a run credential, never the provider key.
 * Only its selected model can be called. Actual provider prices settle one
 * completion at a time; one in-flight call can cross the declared spend ceiling.
 */
export async function startModelGateway(options: ModelGatewayOptions): Promise<ModelGateway> {
  const upstream = new URL(options.baseUrl.replace(/\/$/, "") + "/");
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error("The model provider needs an HTTP(S) API root without credentials or a query.");
  }
  if (!options.apiKey || !options.model || !options.runId) throw new Error("A model gateway needs its run, selected model and provider credential.");
  if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) {
    throw new Error("The model spend limit must be a nonnegative finite amount.");
  }
  const token = randomBytes(32).toString("hex");
  const totals: ModelGatewaySpend = { usd: 0, calls: 0, unpriced: 0 };
  const controllers = new Set<AbortController>();
  let busy = false;
  let stopped = false;
  let limitReason: string | undefined;
  let stopping: Promise<void> | undefined;
  const limit = (reason: string) => {
    if (limitReason) return;
    limitReason = reason;
    // Let the captured provider response reach Inspect before cancellation.
    setImmediate(() => options.onLimit?.(reason));
  };
  const checkBudget = () => {
    const other = options.getOtherCost?.() ?? { usd: 0, unpriced: 0 };
    if (!Number.isFinite(other.usd) || other.usd < 0 || !Number.isFinite(other.unpriced) || other.unpriced < 0) {
      limit("The other-role spend record is invalid; the evaluation cannot enforce its budget.");
    } else if (totals.unpriced || other.unpriced) {
      limit("A provider omitted its price, so the declared spend guard cannot be enforced. Partial evaluation retained.");
    } else if (options.maxCostUsd !== undefined && totals.usd + other.usd >= options.maxCostUsd) {
      limit("Declared agent and world spend budget exhausted; this is a partial evaluation.");
    }
    return !limitReason;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(token);
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(response, 401, "This model gateway requires its run credential."); return;
    }
    const models = request.method === "GET" && request.url === "/v1/models";
    const completion = request.method === "POST" && request.url === "/v1/chat/completions";
    if (!models && !completion) { reply(response, 403, "This model API route is unavailable."); return; }
    if (stopped || limitReason) { reply(response, 402, limitReason ?? "This run's model gateway is closed."); return; }
    let body: Record<string, unknown> | undefined;
    if (completion) {
      if (!request.headers["content-type"]?.startsWith("application/json")) { reply(response, 415, "Use an application/json request."); return; }
      try { body = await requestBody(request); }
      catch { reply(response, 400, "Invalid or oversized model request."); return; }
      if (body.model !== options.model || body.models !== undefined || (body.n !== undefined && body.n !== 1)) {
        reply(response, 403, "Only this run's selected model and one completion are permitted."); return;
      }
      if (body.stream === true) { reply(response, 400, "This harness uses complete JSON responses; configure stream=false."); return; }
      const tokenBounds = [body.max_tokens, body.max_completion_tokens].filter(value => value !== undefined);
      if (!tokenBounds.length || tokenBounds.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > (options.maxTokens ?? 8192))) {
        reply(response, 400, "This completion exceeds the configured token bound."); return;
      }
      if (busy) { reply(response, 409, "A completion is already in flight for this run."); return; }
      if (stopped) { reply(response, 402, "This run's model gateway is closed."); return; }
      if (!checkBudget()) { reply(response, 402, limitReason!); return; }
      busy = true;
      body.stream = false;
      body.usage = { include: true };
    }
    const controller = new AbortController();
    controllers.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", disconnected);
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 100_000);
    let accounted = false;
    try {
      const result = await fetch(new URL(models ? "models" : "chat/completions", upstream), {
        method: models ? "GET" : "POST", redirect: "manual", signal: controller.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (result.status >= 300 && result.status < 400) throw new Error("The configured model provider attempted a redirect.");
      const data: unknown = await result.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The model provider returned an invalid response.");
      const record = data as Record<string, unknown>;
      if (completion) {
        const usage = record.usage as Record<string, unknown> | undefined;
        const cost = usage?.cost;
        totals.calls++;
        if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) totals.usd += cost;
        else totals.unpriced++;
        accounted = true;
        checkBudget();
      } else if (Array.isArray(record.data)) {
        record.data = record.data.filter(item => item && typeof item === "object" && item.id === options.model);
      }
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(record));
    } catch {
      // A failed connection or malformed response may still have incurred cost.
      if (completion && !accounted) { totals.calls++; totals.unpriced++; checkBudget(); }
      if (!response.destroyed) reply(response, 502, "The model provider did not return usable evidence; the run has been stopped.");
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      response.removeListener("close", disconnected);
      if (completion) busy = false;
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, token,
    spend: () => ({ ...totals }),
    stop: () => stopping ??= (async () => {
      stopped = true;
      for (const controller of controllers) controller.abort();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    })(),
  };
}
