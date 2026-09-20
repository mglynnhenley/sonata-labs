import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startModelGateway, type ModelGateway, type ModelGatewayOptions } from "../src/lib/engine/modelGateway";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).reverse().map(stop => stop())); });

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>, options: Partial<ModelGatewayOptions> = {}) {
  const calls: Array<{ path?: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ path: request.url, headers: request.headers, body });
    await handler(request, response, body);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    const closed = new Promise<void>(resolve => upstream.close(() => resolve()));
    upstream.closeAllConnections();
    await closed;
  });
  const gateway = await startModelGateway({ runId: "gateway-test", model: "test/selected", apiKey: "provider-secret",
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v1`, ...options });
  cleanup.push(gateway.stop);
  return { gateway, calls };
}
function completion(gateway: ModelGateway, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return fetch(`${gateway.url}/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "test/selected", messages: [{ role: "user", content: "test" }], max_tokens: 100, ...body }),
  });
}
function priced(response: ServerResponse, cost = 0.2) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recorded" } }], usage: { cost, prompt_tokens: 4, completion_tokens: 2 } }));
}

describe("the run's controlled model gateway", () => {
  it("exchanges only its run credential for the provider key and retains the actual response price", async () => {
    const { gateway, calls } = await fixture((_request, response) => priced(response));
    const response = await completion(gateway, {}, { "x-forwarded-host": "evil.test", "x-api-key": "client-key" });
    expect(response.status).toBe(200);
    expect((await response.json()).usage).toEqual({ cost: 0.2, prompt_tokens: 4, completion_tokens: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer provider-secret");
    expect(calls[0].headers["x-forwarded-host"]).toBeUndefined();
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
    expect(calls[0].body.usage).toEqual({ include: true });
    expect(gateway.spend()).toEqual({ usd: 0.2, calls: 1, unpriced: 0 });
  });

  it("rejects credential, model, route, streaming and token-bound escapes before contacting a provider", async () => {
    const { gateway, calls } = await fixture((_request, response) => priced(response));
    expect((await completion(gateway, {}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await completion(gateway, {}, { authorization: `Bearer ${"é".repeat(64)}` })).status).toBe(401);
    expect((await completion(gateway, {}, { origin: "http://browser.test" })).status).toBe(401);
    for (const body of [{ model: "test/other" }, { models: ["test/other"] }, { n: 2 }]) expect((await completion(gateway, body)).status).toBe(403);
    for (const body of [{ stream: true }, { max_tokens: 0 }, { max_tokens: 9000 }, { max_completion_tokens: 9000 }]) {
      expect((await completion(gateway, body)).status).toBe(400);
    }
    for (const suffix of ["/responses", "/chat/completions?url=http://evil.test", "/models/other"]) {
      expect((await fetch(`${gateway.url}${suffix}`, { headers: { authorization: `Bearer ${gateway.token}` } })).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("settles one completion and prevents the next when agent plus world spend reaches the limit", async () => {
    const onLimit = vi.fn();
    const { gateway, calls } = await fixture((_request, response) => priced(response, 0.2), {
      maxCostUsd: 0.3, getOtherCost: () => ({ usd: 0.1, unpriced: 0 }), onLimit,
    });
    expect((await completion(gateway)).status).toBe(200);
    expect((await completion(gateway)).status).toBe(402);
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(onLimit).toHaveBeenCalledOnce());
    expect(gateway.spend().usd).toBe(0.2);
  });

  it("refuses to dispatch when the world has already consumed the budget or omitted a price", async () => {
    for (const other of [{ usd: 1, unpriced: 0 }, { usd: 0, unpriced: 1 }]) {
      const { gateway, calls } = await fixture((_request, response) => priced(response), { maxCostUsd: 1, getOtherCost: () => other });
      expect((await completion(gateway)).status).toBe(402);
      expect(calls).toHaveLength(0);
    }
  });

  it("retains an unpriced completion and blocks further calls instead of inventing a cost", async () => {
    const { gateway, calls } = await fixture((_request, response) => { response.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 4 } })); });
    const response = await completion(gateway);
    expect(response.status).toBe(200);
    expect((await response.json()).usage.cost).toBeUndefined();
    expect(gateway.spend()).toEqual({ usd: 0, calls: 1, unpriced: 1 });
    expect((await completion(gateway)).status).toBe(402);
    expect(calls).toHaveLength(1);
  });

  it("allows no second provider completion while the first has an unknown in-flight cost", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const { gateway, calls } = await fixture(async (_request, response) => { await pending; priced(response); });
    const first = completion(gateway);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((await completion(gateway)).status).toBe(409);
    finish();
    expect((await first).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("does not follow upstream redirects or leak their destinations to the harness", async () => {
    const { gateway, calls } = await fixture((_request, response) => {
      response.writeHead(307, { location: "http://127.0.0.1:1/private" }); response.end();
    });
    const response = await completion(gateway);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("provider-secret");
    expect(calls).toHaveLength(1);
    expect(gateway.spend().unpriced).toBe(1);
    expect((await completion(gateway)).status).toBe(402);
  });

  it("returns only the selected model's real metadata", async () => {
    const { gateway, calls } = await fixture((_request, response) => { response.end(JSON.stringify({ data: [{ id: "test/selected", pricing: { prompt: "0.01" } }, { id: "test/other" }] })); });
    const response = await fetch(`${gateway.url}/models`, { headers: { authorization: `Bearer ${gateway.token}` } });
    expect(await response.json()).toEqual({ data: [{ id: "test/selected", pricing: { prompt: "0.01" } }] });
    expect(calls[0].path).toBe("/api/v1/models");
    expect(gateway.spend()).toEqual({ usd: 0, calls: 0, unpriced: 0 });
  });

  it("enforces a provider deadline and retains unknown spend when the response never arrives", async () => {
    const { gateway, calls } = await fixture(() => undefined, { timeoutMs: 25 });
    expect((await completion(gateway)).status).toBe(502);
    expect(gateway.spend()).toEqual({ usd: 0, calls: 1, unpriced: 1 });
    expect((await completion(gateway)).status).toBe(402);
    expect(calls).toHaveLength(1);
  });

  it("cancels the provider when its Inspect client disconnects and discloses the unknown price", async () => {
    let upstreamClosed = false;
    const { gateway, calls } = await fixture((_request, response) => { response.once("close", () => { upstreamClosed = true; }); });
    const controller = new AbortController();
    const pending = fetch(`${gateway.url}/chat/completions`, { method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "test/selected", max_tokens: 100, messages: [] }),
    }).catch(() => null);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
    expect(gateway.spend()).toEqual({ usd: 0, calls: 1, unpriced: 1 });
    expect((await completion(gateway)).status).toBe(402);
  });

  it("cancels an in-flight provider request, closes its listener and tolerates repeated cleanup", async () => {
    const { gateway, calls } = await fixture(() => undefined);
    const pending = completion(gateway).catch(() => null);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await Promise.all([gateway.stop(), gateway.stop()]);
    await pending;
    await expect(completion(gateway)).rejects.toThrow();
    expect(gateway.spend()).toEqual({ usd: 0, calls: 1, unpriced: 1 });
  });
});
