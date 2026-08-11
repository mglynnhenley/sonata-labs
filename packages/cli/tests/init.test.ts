import { describe, expect, it } from "vitest";
import { upsertEnvLine } from "../src/init";
import { parseEnvKeys } from "../src/diagnose";

// `sonata init` is run on machines that already work, so the only thing that
// matters about the way it writes .env is what it leaves alone.

describe("upsertEnvLine", () => {
  it("writes a file, with the note about the name that matters", () => {
    const written = upsertEnvLine("", "OPENROUTER_API_KEY", "sk-or-1");
    expect(parseEnvKeys(written).get("OPENROUTER_API_KEY")).toBe("sk-or-1");
    expect(written).toContain("OPEN_ROUTER_KEY is silently ignored");
  });

  it("replaces the line in place and keeps every other setting", () => {
    const before = ["# a comment", "OPENROUTER_API_KEY=old", "PORT=3101", "SANDBOX_TOKEN=abc"].join("\n");
    const after = upsertEnvLine(before, "OPENROUTER_API_KEY", "new");
    const keys = parseEnvKeys(after);
    expect(keys.get("OPENROUTER_API_KEY")).toBe("new");
    expect(keys.get("PORT")).toBe("3101");
    expect(keys.get("SANDBOX_TOKEN")).toBe("abc");
    expect(after).toContain("# a comment");
    expect(after.split("\n").filter((l) => l.startsWith("OPENROUTER_API_KEY"))).toHaveLength(1);
  });

  it("replaces an exported line rather than adding a second one", () => {
    const after = upsertEnvLine("export OPENROUTER_API_KEY=old\n", "OPENROUTER_API_KEY", "new");
    expect(parseEnvKeys(after).get("OPENROUTER_API_KEY")).toBe("new");
    expect(after).not.toContain("old");
  });

  it("appends to a file that has other settings but no key", () => {
    const after = upsertEnvLine("PORT=3101\n", "OPENROUTER_API_KEY", "sk-or-1");
    expect(parseEnvKeys(after).get("PORT")).toBe("3101");
    expect(parseEnvKeys(after).get("OPENROUTER_API_KEY")).toBe("sk-or-1");
  });
});
