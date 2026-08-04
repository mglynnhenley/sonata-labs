import type { TimelineEntry } from "@sonata/core";
import { describe, expect, it } from "vitest";
import { doNothingAgent, replyToEverythingAgent, type AgentTool, type Arrival } from "../src/controls";

// The controls exist to check the scoring, so what matters is that they behave as
// badly as advertised — a do-nothing agent that quietly does something would make
// the floor of the benchmark meaningless.

function tool(name: string, twin: AgentTool["twin"], calls: unknown[]): AgentTool {
  return {
    name,
    twin,
    description: name,
    async call(args) {
      calls.push(args);
      return { ok: true };
    },
  };
}

function arrival(twin: TimelineEntry["twin"], id: string, containerId?: string): Arrival {
  return {
    entry: { tick: 1, simTimeISO: "2026-08-04T09:15:00Z", source: "world", twin, text: "x" },
    handle: twin ? { twin, id, ...(containerId ? { containerId } : {}) } : undefined,
  };
}

function ctx(arrivals: Arrival[], tools: AgentTool[]) {
  return {
    tick: 1,
    simTimeISO: "2026-08-04T09:15:00Z",
    task: "Run ops today.",
    arrivals,
    tools,
    note: () => {},
    escalate: () => {},
  };
}

describe("doNothingAgent", () => {
  it("touches nothing, whatever the day puts in front of it", async () => {
    const calls: unknown[] = [];
    const agent = doNothingAgent();
    await agent.tick(ctx([arrival("gmail", "M1", "T1")], [tool("send_reply", "gmail", calls)]));
    expect(calls).toEqual([]);
    expect(await agent.finish?.()).toBeUndefined();
  });
});

describe("replyToEverythingAgent", () => {
  it("answers every arrival on its own surface, with the same words", async () => {
    const gmailCalls: unknown[] = [];
    const slackCalls: unknown[] = [];
    const agent = replyToEverythingAgent();

    await agent.tick(
      ctx(
        [arrival("gmail", "M1", "T1"), arrival("slack", "100.1", "C01OPS")],
        [tool("send_reply", "gmail", gmailCalls), tool("post_message", "slack", slackCalls)],
      ),
    );

    expect(gmailCalls).toHaveLength(1);
    expect(slackCalls).toHaveLength(1);
    expect(gmailCalls[0]).toMatchObject({ threadId: "T1", body: expect.stringContaining("Thanks") });
    expect(slackCalls[0]).toMatchObject({ channel: "C01OPS", text: expect.stringContaining("Thanks") });
  });

  it("never replies to itself", async () => {
    const calls: unknown[] = [];
    const own = arrival("gmail", "M1", "T1");
    own.entry.source = "agent";
    await replyToEverythingAgent().tick(ctx([own], [tool("send_reply", "gmail", calls)]));
    expect(calls).toEqual([]);
  });

  it("skips an arrival with no handle to act on", async () => {
    const calls: unknown[] = [];
    const orphan = arrival("gmail", "M1");
    orphan.handle = undefined;
    await replyToEverythingAgent().tick(ctx([orphan], [tool("send_reply", "gmail", calls)]));
    expect(calls).toEqual([]);
  });

  it("falls back to whatever mutating tool the twin offers", async () => {
    const calls: unknown[] = [];
    await replyToEverythingAgent().tick(
      ctx([arrival("gmail", "M1", "T1")], [tool("create_and_send_thing", "gmail", calls)]),
    );
    expect(calls).toHaveLength(1);
  });

  it("stays within its per-tick bound on a busy tick", async () => {
    const calls: unknown[] = [];
    const arrivals = Array.from({ length: 25 }, (_, i) => arrival("gmail", `M${i}`, `T${i}`));
    const agent = replyToEverythingAgent({ maxPerTick: 3 });
    await agent.tick(ctx(arrivals, [tool("send_reply", "gmail", calls)]));
    expect(calls).toHaveLength(3);
    expect(await agent.finish?.()).toContain("3 message(s)");
  });
});
