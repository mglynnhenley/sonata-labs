import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActionRow } from "@/lib/audit";

// Trace capture, exercised end-to-end against a local stand-in for OpenRouter —
// no key, no network, no tokens. The two properties that matter: capture is inert
// outside a run (so eval:check and the rest of the suite are untouched), and
// inside one it attributes every model call to the right harness role.

let server: Server;
let requestCount = 0;

let trace: typeof import("@/lib/eval/trace");
let llm: typeof import("@/lib/eval/llm");

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "mock",
          object: "chat.completion",
          created: 0,
          model: "mock/model",
          choices: [
            { index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;

  trace = await import("@/lib/eval/trace");
  llm = await import("@/lib/eval/llm");
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
} as const;

const ask = () =>
  llm.completeJSON({
    prompt: "hi",
    schema: SCHEMA as unknown as Record<string, unknown>,
  });

describe("capture is inert outside a run", () => {
  it("records nothing and still returns a result", async () => {
    const before = requestCount;
    expect(trace.currentTrace()).toBeUndefined();
    await ask();
    expect(requestCount).toBe(before + 1);
    expect(trace.currentTrace()).toBeUndefined();
  });
});

describe("capture inside a run", () => {
  it("attributes each call to the role that made it", async () => {
    const t = trace.newTrace("run-1");
    await trace.withTrace(t, async () => {
      await trace.withRole("profiler", ask);
      await trace.withRole("generator", ask);
      await trace.withRole("judge", ask);
    });
    expect(t.llmCalls.map((c) => c.role)).toEqual(["profiler", "generator", "judge"]);
  });

  it("treats an unlabelled call as the agent's", async () => {
    // Anything inside the run but outside a withRole came from the agent under
    // test — the harness's own stages all name themselves.
    const t = trace.newTrace("run-2");
    await trace.withTrace(t, ask);
    expect(t.llmCalls).toHaveLength(1);
    expect(t.llmCalls[0].role).toBe("agent");
  });

  it("captures request and response bodies verbatim", async () => {
    const t = trace.newTrace("run-3");
    await trace.withTrace(t, ask);
    const call = t.llmCalls[0];
    expect((call.request as { messages: unknown[] }).messages).toBeDefined();
    expect((call.response as { usage: { total_tokens: number } }).usage.total_tokens).toBe(18);
    expect(call.endedAt).toBeGreaterThanOrEqual(call.startedAt);
    expect(call.error).toBeUndefined();
  });

  it("interleaves model calls and tool calls in one sequence", async () => {
    const t = trace.newTrace("run-4");
    await trace.withTrace(t, async () => {
      await ask();
      trace.recordToolCall({
        name: "get_thread",
        args: { threadId: "t1" },
        result: {},
        isMutation: false,
        startedAt: 1,
        endedAt: 2,
      });
      await ask();
    });
    const seqs = [...t.llmCalls, ...t.toolCalls].map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe("attributing audit rows to tool calls", () => {
  const row = (id: number, ts: number): ActionRow =>
    ({ id, ts, session_id: "s", method: "POST", endpoint: "/x", action_type: "modify",
       target_type: "message", target_id: "m", request_json: null, response_code: 200,
       summary: "" }) as ActionRow;

  const archive = (error?: string) => ({
    name: "archive", args: {}, result: {}, isMutation: true,
    startedAt: 0, endedAt: 0, ...(error ? { error } : {}),
  });

  it("pairs the Nth successful mutation with the Nth audit row", () => {
    const t = trace.newTrace("run-5");
    trace.withTrace(t, async () => {
      trace.recordToolCall(archive());
      trace.recordToolCall(archive());
    });
    trace.attributeActions(t, [row(1, 150), row(2, 350)]);
    expect(t.toolCalls[0].actionIds).toEqual([1]);
    expect(t.toolCalls[1].actionIds).toEqual([2]);
  });

  it("does not consume a row for a call that errored", () => {
    // A rejected mutation writes no audit row, so it must not shift the pairing
    // of every call after it.
    const t = trace.newTrace("run-6");
    trace.withTrace(t, async () => {
      trace.recordToolCall(archive("UNIQUE constraint failed"));
      trace.recordToolCall(archive());
    });
    trace.attributeActions(t, [row(7, 150)]);
    expect(t.toolCalls[0].actionIds).toEqual([]);
    expect(t.toolCalls[1].actionIds).toEqual([7]);
  });

  it("never attributes rows to reads", () => {
    const t = trace.newTrace("run-7");
    trace.withTrace(t, async () => {
      trace.recordToolCall({ name: "get_thread", args: {}, result: {}, isMutation: false,
        startedAt: 100, endedAt: 900 });
    });
    trace.attributeActions(t, [row(1, 500)]);
    expect(t.toolCalls[0].actionIds).toEqual([]);
  });

  it("pairs only up to the shorter list when the two diverge", () => {
    // If anything else wrote to the log mid-run the invariant breaks; keep the
    // correct prefix rather than misattributing everything after it.
    const t = trace.newTrace("run-8");
    trace.withTrace(t, async () => {
      trace.recordToolCall(archive());
      trace.recordToolCall(archive());
    });
    trace.attributeActions(t, [row(1, 10)]);
    expect(t.toolCalls[0].actionIds).toEqual([1]);
    expect(t.toolCalls[1].actionIds).toEqual([]);
  });

  it("orders rows by id, not by arrival", () => {
    const t = trace.newTrace("run-9");
    trace.withTrace(t, async () => {
      trace.recordToolCall(archive());
      trace.recordToolCall(archive());
    });
    trace.attributeActions(t, [row(9, 20), row(4, 10)]);
    expect(t.toolCalls[0].actionIds).toEqual([4]);
    expect(t.toolCalls[1].actionIds).toEqual([9]);
  });

  it("separates reads from mutations", () => {
    const t = trace.newTrace("run-7");
    trace.withTrace(t, async () => {
      trace.recordToolCall({ name: "get_thread", args: {}, result: {}, isMutation: false,
        startedAt: 1, endedAt: 2 });
      trace.recordToolCall({ name: "archive", args: {}, result: {}, isMutation: true,
        startedAt: 3, endedAt: 4 });
    });
    expect(trace.readCalls(t).map((c) => c.name)).toEqual(["get_thread"]);
  });
});
