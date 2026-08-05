import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiKey,
  cachesByBreakpoint,
  getClient,
  resetClient,
  setApiKey,
  withCacheBreakpoints,
} from "../src/llm";

// The engine is used two ways and only one of them has an environment variable.
// The CLI exports OPENROUTER_API_KEY; the dashboard keeps the key in platform.db
// because a user typed it into Settings. Before `setApiKey` existed, the second
// case failed at the director — a run seeded its twins, fired its beats, and
// then every tick logged "OPENROUTER_API_KEY is not set" while the Settings page
// showed a saved key. A world with a silent director still looks like it is
// running, so this is worth pinning.

const ENV = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  setApiKey(null);
  resetClient();
});

afterEach(() => {
  setApiKey(null);
  resetClient();
  if (ENV === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ENV;
});

describe("where the key comes from", () => {
  it("has none when neither the host nor the environment supplied one", () => {
    expect(apiKey()).toBeNull();
  });

  it("reads the environment when the host supplied nothing", () => {
    process.env.OPENROUTER_API_KEY = "sk-env";
    expect(apiKey()).toBe("sk-env");
  });

  it("prefers the host's key over the environment", () => {
    process.env.OPENROUTER_API_KEY = "sk-env";
    setApiKey("sk-stored");
    expect(apiKey()).toBe("sk-stored");
  });

  it("falls back to the environment when the host clears its key", () => {
    process.env.OPENROUTER_API_KEY = "sk-env";
    setApiKey("sk-stored");
    setApiKey(null);
    expect(apiKey()).toBe("sk-env");
  });

  it("treats blank as absent, so an empty Settings field is not a key", () => {
    setApiKey("   ");
    expect(apiKey()).toBeNull();
  });
});

describe("the memoized client", () => {
  it("says how to fix it rather than naming only the environment variable", () => {
    // The old message named OPENROUTER_API_KEY alone, which is a dead end for
    // someone whose key belongs on the Settings page.
    expect(() => getClient()).toThrow(/Settings page/);
    expect(() => getClient()).toThrow(/OPENROUTER_API_KEY/);
  });

  it("is rebuilt when the key changes, not held for the life of the process", () => {
    setApiKey("sk-first");
    const first = getClient();
    expect(getClient()).toBe(first);

    setApiKey("sk-second");
    const second = getClient();
    expect(second).not.toBe(first);
  });

  it("is left alone when the key is set to the value it already had", () => {
    setApiKey("sk-same");
    const first = getClient();
    setApiKey("sk-same");
    expect(getClient()).toBe(first);
  });
});

// PROMPT CACHING.
//
// The breakpoints are billing-only, which is exactly why they need a test: a
// mistake here does not fail a run or change an answer, it just quietly stops
// saving money — or, worse, quietly reshapes an assistant turn and corrupts the
// tool_calls the agent loop depends on. Neither shows up as a red suite.

describe("prompt cache breakpoints", () => {
  const system = { role: "system" as const, content: "the company, the cast, the brief" };
  const user = { role: "user" as const, content: "It is 09:00." };

  it("marks only providers whose caching is driven by a breakpoint", () => {
    expect(cachesByBreakpoint("anthropic/claude-haiku-4.5")).toBe(true);
    expect(cachesByBreakpoint("openai/gpt-5.4")).toBe(false);
  });

  it("caches the system prompt and the latest tick prompt", () => {
    const out = withCacheBreakpoints([system, user]);
    for (const message of out) {
      expect(message.content).toEqual([
        { type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } },
      ]);
    }
  });

  it("moves the second breakpoint to the newest user turn, never leaving a stale one", () => {
    const out = withCacheBreakpoints([
      system,
      user,
      { role: "assistant", content: "on it" },
      { role: "user", content: "It is 09:15." },
    ]);
    // The earlier tick prompt is settled history and is read back through the
    // newer breakpoint; a marker left on it would buy a second write for nothing.
    expect(out[1]).toEqual(user);
    expect(out[3]?.content).toEqual([
      { type: "text", text: "It is 09:15.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("never rewrites an assistant or tool turn", () => {
    const assistant = {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: "c1", type: "function" as const, function: { name: "gmail.send", arguments: "{}" } },
      ],
    };
    const tool = { role: "tool" as const, tool_call_id: "c1", content: "sent" };
    const out = withCacheBreakpoints([system, user, assistant, tool]);
    expect(out[2]).toBe(assistant);
    expect(out[3]).toBe(tool);
  });

  it("does not touch the caller's array, which the agent loop keeps appending to", () => {
    const messages = [system, user];
    const out = withCacheBreakpoints(messages);
    expect(messages[0]).toBe(system);
    expect(messages[1]).toBe(user);
    expect(out[0]).not.toBe(system);
  });

  it("spends one breakpoint, not two, when there is no user turn yet", () => {
    const out = withCacheBreakpoints([system]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([
      { type: "text", text: system.content, cache_control: { type: "ephemeral" } },
    ]);
  });
});
