import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiKey, getClient, resetClient, setApiKey } from "../src/llm";

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
