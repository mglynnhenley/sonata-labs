import { describe, it, expect } from "vitest";
import { createAgent, agentSystemPrompt, AgentCallError, type AgentContext } from "../src/agent";
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
    // The list is described as a mechanism — whose it is, who reads it — and never
    // as advice about what belongs on it. That line is the benchmark's honesty.
    expect(prompt).toContain("open_items is your own running list");
    expect(prompt).not.toMatch(/should|make sure|remember to/i);
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
    // The tick prompt says a surface changed and never what it says — and says
    // what the agent has left open, which on a day it has written nothing is
    // still said, rather than left to read as "nothing to do".
    expect(String(second[3].content)).toContain("on 2026-08-04 (UTC+00:00)");
    expect(String(second[3].content)).toContain("NEW — new mail in the inbox\nSTILL OPEN — your list is empty.");
  });

  it("shortens a long tool result once its interval is over, and keeps the current one whole", async () => {
    const big = { rows: "x".repeat(20_000) };
    const tool: EngineTool = {
      name: "read_workbook",
      twin: "excel",
      isMutation: false,
      def: fn("read_workbook", "read", { type: "object", properties: {} }),
      run: () => Promise.resolve(big),
    };
    const { chat, asked } = scriptedChat([
      { tool_calls: [toolCall("c1", "read_workbook", {})] },
      { content: "read it" },
      { content: "afternoon" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });

    await agent.act(ctx({ tick: 0 }));
    // Within the interval the model saw the whole result.
    const sameInterval = asked[1].messages.find((m) => m.role === "tool");
    expect(String(sameInterval?.content).length).toBeGreaterThan(20_000);

    await agent.act(ctx({ tick: 1, simTimeLabel: "09:15" }));
    const later = asked[2].messages;
    const stub = later.find((m) => m.role === "tool");
    expect(String(stub?.content).length).toBeLessThan(1_000);
    expect(String(stub?.content)).toContain("removed to keep the conversation within the model's limit");
    expect(String(stub?.content)).toContain("Call the tool again");
    // The prompt says it happened; the tool call and its result are still paired.
    expect(String(later[later.length - 1]!.content)).toContain("CONTEXT — 1 earlier tool result shortened");
    expect(later.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });

  it("drops the oldest intervals whole when the day outgrows the ceiling, and says which", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([
      { tool_calls: [toolCall("c1", "list_messages", {})] },
      { content: "nine" },
      { tool_calls: [toolCall("c2", "list_messages", {})] },
      { content: "quarter past" },
      { content: "half past" },
    ]);
    const agent = createAgent({
      spec: spec(),
      tools: [tool],
      chat,
      // Small enough that two intervals cannot both fit beside the system prompt.
      contextPolicy: { keptToolChars: 100, maxHistoryChars: JSON.stringify(agentSystemPrompt(spec(), [tool])).length + 400 },
    });

    await agent.act(ctx({ tick: 0 }));
    await agent.act(ctx({ tick: 1, simTimeLabel: "09:15" }));
    await agent.act(ctx({ tick: 2, simTimeLabel: "09:30" }));

    const third = asked[asked.length - 1].messages;
    expect(third[0].role).toBe("system");
    expect(String(third[1].content)).toMatch(/^\[Intervals 09:00–09:00 were removed from your context/);
    expect(third.map((m) => String(m.content)).join("\n")).not.toContain("It is 09:00");
    expect(third.map((m) => String(m.content)).join("\n")).toContain("It is 09:15");
    // Dropping whole intervals never orphans a tool call: every assistant tool
    // call still has its tool message right after it.
    third.forEach((m, i) => {
      if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length) expect(third[i + 1]?.role).toBe("tool");
    });
    expect(String(third[third.length - 1]!.content)).toContain("1 earlier interval removed");
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

  it("identifies a provider failure without fabricating an agent thought", async () => {
    const { tool } = recordingTool("list_messages");
    const chat = () => Promise.reject(new Error("provider timed out"));
    await expect(createAgent({ spec: spec(), tools: [tool], chat }).act(ctx()))
      .rejects.toMatchObject({ name: "AgentCallError", message: "Agent model call failed: provider timed out", steps: [] });
  });

  it("preserves successful actions when a later model call fails", async () => {
    const { tool } = recordingTool("send_reply", true);
    let turn = 0;
    const chat = async () => {
      if (turn++) throw new Error("provider unavailable");
      return { role: "assistant", content: null, tool_calls: [toolCall("c1", "send_reply", {})] } as OpenAI.ChatCompletionMessage;
    };
    const error = await createAgent({ spec: spec(), tools: [tool], chat }).act(ctx()).catch(e => e);
    expect(error).toBeInstanceOf(AgentCallError);
    expect(error.steps).toHaveLength(1);
    expect(error.steps[0]).toMatchObject({ kind: "tool", name: "send_reply", isMutation: true });
  });

  it("provides the local date across midnight and the final-interval notice on a one-tick day", async () => {
    const { chat, asked } = scriptedChat([{ content: "waiting" }, { content: "done" }]);
    const day = spec({ clock: { startISO: "2026-09-02T23:45:00-04:00", ticks: 2, simMinutesPerTick: 15 } });
    const agent = createAgent({ spec: day, tools: [], chat });
    await agent.act(ctx({ simTimeISO: "2026-09-03T03:45:00.000Z", simTimeLabel: "23:45" }));
    await agent.act(ctx({ tick: 1, simTimeISO: "2026-09-03T04:00:00.000Z", simTimeLabel: "00:00", ticksLeft: 0 }));
    expect(String(asked[0].messages.at(-1)?.content)).toContain("23:45 on 2026-09-02 (UTC-04:00)");
    expect(String(asked[1].messages.at(-1)?.content)).toContain("00:00 on 2026-09-03 (UTC-04:00)");
    const one = scriptedChat([{ content: "done" }]);
    await createAgent({ spec: spec(), tools: [], chat: one.chat }).act(ctx({ ticksLeft: 0 }));
    expect(String(one.asked[0].messages.at(-1)?.content)).toContain("last interval of the day");
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

  // WHAT THE AGENT STARTED, CARRIED ACROSS TICKS.
  //
  // Before this, the only thing the loop told the agent about its own work was
  // what had just arrived, so a thread it had already read was gone from its
  // world and a reply two hours later landed on an agent with no record of the
  // first one. These pin the carry, the clear, and that it shows up in the prompt.

  it("carries an open item into the next tick's prompt, unread mail or not", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([
      { tool_calls: [toolCall("c1", "open_items", { add: ["waiting on Dana's answer about the refund"] })] },
      { content: "that is all for now" },
      { content: "still waiting" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });

    await agent.act(ctx({ tick: 0, simTimeLabel: "09:00" }));
    await agent.act(ctx({ tick: 1, simTimeLabel: "09:15", digest: "Nothing new has arrived since the last check." }));

    const second = String(asked[2].messages[asked[2].messages.length - 1].content);
    expect(second).toContain(
      [
        "NEW — Nothing new has arrived since the last check.",
        "STILL OPEN — your own list, oldest first:",
        "  [o1] waiting on Dana's answer about the refund (noted 09:00)",
      ].join("\n"),
    );
  });

  it("drops an item from the prompt once the agent says it is done", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat, asked } = scriptedChat([
      { tool_calls: [toolCall("c1", "open_items", { add: ["chase Dana", "book the SLA review"] })] },
      { content: "noted" },
      { tool_calls: [toolCall("c2", "open_items", { done: ["o1"] })] },
      { content: "one down" },
      { content: "carrying on" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });

    await agent.act(ctx({ tick: 0, simTimeLabel: "09:00" }));
    await agent.act(ctx({ tick: 1, simTimeLabel: "09:15" }));
    await agent.act(ctx({ tick: 2, simTimeLabel: "09:30" }));

    const third = String(asked[4].messages[asked[4].messages.length - 1].content);
    expect(third).toContain("[o2] book the SLA review (noted 09:00)");
    expect(third).not.toContain("chase Dana");
  });

  it("records bookkeeping as a thought, not as an action, so an idle tick still looks idle", async () => {
    const { tool } = recordingTool("list_messages");
    const { chat } = scriptedChat([
      { tool_calls: [toolCall("c1", "open_items", { add: ["chase Dana"] })] },
      { content: "done" },
    ]);
    const agent = createAgent({ spec: spec(), tools: [tool], chat });
    const trace = newTrace("run-1");
    const steps = await withTrace(trace, () => agent.act(ctx()));

    expect(steps.map((s) => s.kind)).toEqual(["thought", "thought"]);
    const noted = steps[0];
    if (noted.kind !== "thought") throw new Error("expected a thought");
    expect(noted.text).toBe("open items: noted [o1] chase Dana");
    // Nothing happened on any twin, so nothing is on the trace to be scored.
    expect(trace.toolCalls).toEqual([]);
  });

  it("keeps one list per agent, so two runs never see each other's work", async () => {
    const { tool } = recordingTool("list_messages");
    const script = (): Array<Partial<OpenAI.ChatCompletionMessage>> => [
      { tool_calls: [toolCall("c1", "open_items", { add: ["chase Dana"] })] },
      { content: "done" },
      { content: "next" },
    ];
    const first = scriptedChat(script());
    const second = scriptedChat(script());
    await createAgent({ spec: spec(), tools: [tool], chat: first.chat }).act(ctx({ tick: 0 }));

    const other = createAgent({ spec: spec(), tools: [tool], chat: second.chat });
    await other.act(ctx({ tick: 0 }));
    await other.act(ctx({ tick: 1, simTimeLabel: "09:15" }));
    const prompt = String(second.asked[2].messages[second.asked[2].messages.length - 1].content);
    expect(prompt.match(/chase Dana/g)).toHaveLength(1);
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
