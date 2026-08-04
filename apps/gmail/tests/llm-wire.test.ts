import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Verifies the OpenRouter wire format without a real key or network: a local
// mock stands in for https://openrouter.ai/api/v1 and records what we send.
// Catches structured-output / tool-format regressions that would otherwise only
// surface as a 400 mid-eval-run.

interface Captured {
  path: string;
  auth: string | undefined;
  referer: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
let captured: Captured | null = null;
let nextContent = "{}";

// Env must be set before the module is imported (the client is built lazily).
let completeJSON: typeof import("@/lib/eval/llm").completeJSON;
let TOOLS_PROBE: unknown;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = {
        path: req.url ?? "",
        auth: req.headers["authorization"] as string | undefined,
        referer: req.headers["http-referer"] as string | undefined,
        body: raw ? JSON.parse(raw) : {},
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "mock",
          object: "chat.completion",
          created: 0,
          model: "mock/model",
          choices: [
            { index: 0, message: { role: "assistant", content: nextContent }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;

  const llm = await import("@/lib/eval/llm");
  completeJSON = llm.completeJSON;
  const agents = await import("@/lib/eval/agents");
  // Reach the tool list through a constructed agent's module scope by
  // round-tripping a request (below); here just confirm the module loads.
  TOOLS_PROBE = agents.referenceTriageAgent({ model: "mock/model" });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "score"],
  properties: {
    verdict: { type: "string" },
    score: { type: "number" },
  },
} as const;

describe("OpenRouter request shape", () => {
  it("posts to /chat/completions with a bearer key and attribution header", async () => {
    nextContent = JSON.stringify({ verdict: "ok", score: 1 });
    await completeJSON({
      prompt: "hi",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(captured!.path).toContain("/chat/completions");
    expect(captured!.auth).toBe("Bearer test-key");
    expect(captured!.referer).toBeTruthy();
  });

  it("sends strict json_schema structured output", async () => {
    nextContent = JSON.stringify({ verdict: "ok", score: 1 });
    await completeJSON({
      prompt: "hi",
      schema: SCHEMA as unknown as Record<string, unknown>,
      schemaName: "my_schema",
      model: "mock/model",
    });
    const rf = captured!.body.response_format as Record<string, unknown>;
    expect(rf.type).toBe("json_schema");
    const js = rf.json_schema as Record<string, unknown>;
    expect(js.name).toBe("my_schema");
    expect(js.strict).toBe(true);
    expect(js.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("maps system + prompt onto chat messages", async () => {
    nextContent = JSON.stringify({ verdict: "ok", score: 1 });
    await completeJSON({
      system: "you are a judge",
      prompt: "grade this",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    const msgs = captured!.body.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "system", content: "you are a judge" });
    expect(msgs[1]).toMatchObject({ role: "user", content: "grade this" });
  });

  it("sends OpenRouter's unified reasoning field only when effort is given", async () => {
    nextContent = JSON.stringify({ verdict: "ok", score: 1 });
    await completeJSON({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
      effort: "high",
    });
    expect(captured!.body.reasoning).toEqual({ effort: "high" });

    await completeJSON({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(captured!.body.reasoning).toBeUndefined();
  });

  it("never sends sampling params (gpt-5.4 rejects temperature)", async () => {
    nextContent = JSON.stringify({ verdict: "ok", score: 1 });
    await completeJSON({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(captured!.body.temperature).toBeUndefined();
    expect(captured!.body.top_p).toBeUndefined();
    expect(captured!.body.top_k).toBeUndefined();
  });
});

describe("response parsing", () => {
  it("parses a clean JSON body", async () => {
    nextContent = JSON.stringify({ verdict: "clean", score: 0.5 });
    const out = await completeJSON<{ verdict: string; score: number }>({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(out).toEqual({ verdict: "clean", score: 0.5 });
  });

  it("tolerates markdown-fenced JSON from soft-honouring providers", async () => {
    nextContent = '```json\n{"verdict":"fenced","score":2}\n```';
    const out = await completeJSON<{ verdict: string }>({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(out.verdict).toBe("fenced");
  });

  it("tolerates prose wrapped around the JSON object", async () => {
    nextContent = 'Here you go:\n{"verdict":"prosey","score":3}\nHope that helps!';
    const out = await completeJSON<{ verdict: string }>({
      prompt: "x",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "mock/model",
    });
    expect(out.verdict).toBe("prosey");
  });

  it("throws a useful error on an empty completion", async () => {
    nextContent = "";
    await expect(
      completeJSON({
        prompt: "x",
        schema: SCHEMA as unknown as Record<string, unknown>,
        model: "mock/model",
      }),
    ).rejects.toThrow(/Empty response/);
  });

  it("throws a useful error on unrecoverable output", async () => {
    nextContent = "not json at all";
    await expect(
      completeJSON({
        prompt: "x",
        schema: SCHEMA as unknown as Record<string, unknown>,
        model: "mock/model",
      }),
    ).rejects.toThrow(/unparseable JSON/);
  });
});

describe("reference agent", () => {
  it("constructs and names itself after the OpenRouter slug", () => {
    const agent = TOOLS_PROBE as { name: string };
    expect(agent.name).toContain("mock/model");
  });

  it("sends OpenAI-shaped function tools and stops when no tool_calls come back", async () => {
    const { referenceTriageAgent } = await import("@/lib/eval/agents");
    const agent = referenceTriageAgent({ model: "mock/model" });
    nextContent = "All done — nothing needed triage.";

    // No tool_calls in the mock reply, so the loop should exit after one turn.
    await agent.triage({
      // The loop returns before touching gmail when there are no tool calls.
      gmail: {} as never,
      userId: "me",
      brief: "triage my inbox",
    });

    const tools = captured!.body.tools as Array<{
      type: string;
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(typeof t.function.name).toBe("string");
      expect(t.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(t.function.parameters).toMatchObject({ type: "object" });
    }
    // The tools the history-aware scenarios depend on must be exposed.
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("get_thread");
    expect(names).toContain("modify_labels");
    expect(names).toContain("archive");
    expect(names).toContain("send_reply");

    const msgs = captured!.body.messages as Array<{ role: string }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });
});
