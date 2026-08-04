import { describe, it, expect } from "vitest";
import { createAgent, agentSystemPrompt, type AgentContext } from "../src/agent";
import type { ChatOptions, OpenAI } from "../src/llm";
import { fn, type EngineTool, type ToolInput } from "../src/tools/types";
import { newTrace, withTrace } from "../src/trace";
import { spec } from "./fixtures";

// The agent is the thing under test in production and a stub here: what these
// assertions pin is the SHAPE of what it emits, because the timeline, the
// checklist and the autonomy score all read `AgentStep[]` and nothing else.

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  tick: 0,
  simTimeLabel: "09:00",
  simTimeISO: "2026-08-04T09:00:00.000Z",
  digest: "new mail in the inbox",
  ticksLeft: 3,
  ...over,
});

function recordingTool(name: string, isMutation = false) {
  const seen: ToolInput[] = [];
  const tool: EngineTool = {
    name,
    twin: "gmail",
    isMutation,
    def: fn(name, name, { type: "object", properties: {} }),
    run(args) {
      seen.push(args);
      return Promise.resolve({ messages: [{ id: "m1" }] });
    },
  };
  return { tool, seen };
}

/** A scripted model: one queued message per turn, and a record of the prompts. */
function scriptedChat(turns: Array<Partial<OpenAI.ChatCompletionMessage>>) {
  const asked: ChatOptions[] = [];
  let i = 0;
  const chat = (opts: ChatOptions): Promise<OpenAI.ChatCompletionMessage> => {
    asked.push({ ...opts, messages: [...opts.messages] });
    const next = turns[i++] ?? { content: "done" };
    return Promise.resolve({ role: "assistant", content: null, ...next } as OpenAI.ChatCompletionMessage);
  };
  return { chat, asked };
}

const toolCall = (id: string, name: string, args: unknown): OpenAI.ChatCompletionMessageToolCall =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } }) as OpenAI.ChatCompletionMessageToolCall;

describe("agentSystemPrompt", () => {
  it("hands over the brief, the identity and the surfaces, once", () => {
    const { tool } = recordingTool("list_messages");
    const prompt = agentSystemPrompt(spec(), [tool]);
    expect(prompt).toContain("Priya Raman's assistant at Northwind Logistics");
    expect(prompt).toContain("priya@northwind.test");
    expect(prompt).toContain("Keep the client informed");
    expect(prompt).toContain("escalate_to_owner");
  });
});

describe("createAgent", () => {
  it("emits a thought, then a tool step, and feeds the result back to the model", async () => {
    const { tool, seen } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([
      { content: "let me look", tool_calls: [toolCall("c1", "list_messages", { limit: 5 })] },
      { content: "nothing to do" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });

    const steps = await agent.act(ctx());
    expect(steps.map((s) => s.kind)).toEqual(["thought", "tool", "thought"]);
    expect(seen).toEqual([{ limit: 5 }]);

    const step = steps[1];
    if (step.kind !== "tool") throw new Error("expected a tool step");
    expect(step).toMatchObject({
      twin: "gmail",
      name: "list_messages",
      args: { limit: 5 },
      resultSummary: "1 messages",
      isMutation: false,
    });
    // The tool's result went back into the conversation, as a tool message.
    const last = asked[1].messages[asked[1].messages.length - 1];
    expect(last.role).toBe("tool");
  });

  it("keeps one conversation across the day, so 14:00 remembers 09:15", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([{ content: "morning" }, { content: "afternoon" }]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });

    await agent.act(ctx({ tick: 0 }));
    await agent.act(ctx({ tick: 1, simTimeLabel: "09:15" }));

    const second = asked[1].messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(String(second[1].content)).toContain("It is 09:00");
    expect(String(second[1].content)).toContain("start of your day");
    expect(String(second[3].content)).toContain("It is 09:15");
    // The tick prompt says a surface changed and never what it says.
    expect(String(second[3].content)).toBe("It is 09:15. new mail in the inbox");
  });

  it("counts an escalation as its own kind, not as a tool call", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat } = scriptedChat([
      { tool_calls: [toolCall("c1", "escalate_to_owner", { reason: "cannot promise a date" })] },
      { content: "handed over" },
    ]);
    const steps = await createAgent({ spec: spec(), tools: [tool], chat }).act(ctx());
    const escalation = steps.find((s) => s.kind === "escalation");
    expect(escalation).toBeDefined();
    if (escalation?.kind !== "escalation") throw new Error("expected an escalation");
    expect(escalation.text).toBe("cannot promise a date");
    expect(steps.some((s) => s.kind === "tool")).toBe(false);
  });

  it("records a failing tool as a failed step and tells the model", async () => {
    const failing: EngineTool = {
      name: "send_reply",
      twin: "gmail",
      isMutation: true,
      def: fn("send_reply", "reply", { type: "object", properties: {} }),
      run: () => Promise.reject(new Error("thread not found")),
    };
    const { chat } = scriptedChat([
      { tool_calls: [toolCall("c1", "send_reply", { messageId: "m9" })] },
      { content: "giving up" },
    ]);
    const steps = await createAgent({ spec: spec(), tools: [failing], chat }).act(ctx());
    const step = steps[0];
    if (step.kind !== "tool") throw new Error("expected a tool step");
    expect(step.error).toBe("thread not found");
    expect(step.resultSummary).toBe("error: thread not found");
  });

  it("hands a hallucinated tool name back to the model instead of crashing", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat } = scriptedChat([
      { tool_calls: [toolCall("c1", "delete_everything", {})] },
      { content: "sorry" },
    ]);
    const steps = await createAgent({ spec: spec(), tools: [tool], chat }).act(ctx());
    const step = steps[0];
    if (step.kind !== "tool") throw new Error("expected a tool step");
    expect(step.error).toBe("no such tool: delete_everything");
    expect(step.twin).toBeNull();
  });

  it("survives malformed tool arguments", async () => {
    const { tool, seen } = recordingTool("list_messages");
    const { chat } = scriptedChat([
      { tool_calls: [{ id: "c1", type: "function", function: { name: "list_messages", arguments: "{oops" } } as OpenAI.ChatCompletionMessageToolCall] },
      { content: "done" },
    ]);
    await createAgent({ spec: spec(), tools: [tool], chat }).act(ctx());
    expect(seen).toEqual([{}]);
  });

  it("stops after maxStepsPerTick and says that it did", async () => {
    const { tool, seen } = recordingTool("list_messages");
    const chat = () =>
      Promise.resolve({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c1", "list_messages", {})],
      } as OpenAI.ChatCompletionMessage);
    const steps = await createAgent({ spec: spec(), tools: [tool], chat, maxStepsPerTick: 3 }).act(ctx());
    expect(seen).toHaveLength(3);
    const last = steps[steps.length - 1];
    if (last.kind !== "thought") throw new Error("expected a closing thought");
    expect(last.text).toBe("stopped after 3 steps in one interval");
  });

  it("loses the tick, not the day, when the model call fails", async () => {
    const { tool } = recordingTool("list_messages");
    const chat = () => Promise.reject(new Error("provider timed out"));
    const steps = await createAgent({ spec: spec(), tools: [tool], chat }).act(ctx());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "thought", text: "the model call failed: provider timed out" });
  });

  it("numbers steps monotonically across the whole day", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat } = scriptedChat([
      { content: "one", tool_calls: [toolCall("c1", "list_messages", {})] },
      { content: "two" },
      { content: "three" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });
    const first = await agent.act(ctx({ tick: 0 }));
    const second = await agent.act(ctx({ tick: 1 }));
    expect([...first, ...second].map((s) => s.seq)).toEqual([0, 1, 2, 3]);
  });

  it("stamps its tool calls with the tick they happened on", async () => {
    const { tool } = recordingTool("send_reply", true);
    const { chat } = scriptedChat([
      { tool_calls: [toolCall("c1", "send_reply", { body: "on its way" })] },
      { content: "done" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });
    const trace = newTrace("run-1");
    await withTrace(trace, () => agent.act(ctx({ tick: 3 })));

    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]).toMatchObject({ name: "send_reply", twin: "gmail", isMutation: true, tick: 3 });
  });

  it("asks for a closing account of the day and records it on the trace", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([{ content: "I answered Dana and told #ops." }]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });
    const trace = newTrace("run-1");
    const summary = await withTrace(trace, () => agent.wrapUp());

    expect(summary).toBe("I answered Dana and told #ops.");
    expect(trace.agentSummary).toBe("I answered Dana and told #ops.");
    // No tools on the closing turn: it is an account, not another chance to act.
    expect(asked[0].tools).toBeUndefined();
  });
});
