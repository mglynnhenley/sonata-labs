import { describe, expect, it } from "vitest";
import { TwinHttp } from "@sonata/engine/http";
import { calendarTools, gmailTools, slackTools } from "@sonata/engine/tools/index";
import { buildManifest, engineToolsFor, toInputSchema } from "../src/manifest";
import { buildTools, toolDescriptors } from "../src/server";
import { fetchFake, testConfig } from "./fixtures";

// The anti-drift test. If someone renames a tool in packages/engine/src/tools, or
// rewords a description, or adds a thirteenth Gmail tool, this file is where the
// connector notices — because the only thing it asserts is that the two lists are
// the same list.

const fake = fetchFake({});
const manifest = () => buildManifest({ config: testConfig, fetchImpl: fake.fetch });

function engineNames(): string[] {
  const http = new TwinHttp({ baseUrl: "http://x.test", fetchImpl: fake.fetch });
  return [
    ...gmailTools(http).map((t) => `gmail_${t.name}`),
    ...slackTools(http).map((t) => `slack_${t.name}`),
    ...calendarTools(http).map((t) => `calendar_${t.name}`),
  ];
}

describe("manifest", () => {
  it("serves exactly the engine's tools, twin-prefixed", () => {
    expect(manifest().entries.map((e) => e.name)).toEqual(engineNames());
  });

  it("carries every description and schema through verbatim", () => {
    const http = new TwinHttp({ baseUrl: "http://x.test", fetchImpl: fake.fetch });
    for (const twin of ["gmail", "slack", "calendar"] as const) {
      for (const tool of engineToolsFor(twin, http)) {
        const entry = manifest().entries.find((e) => e.name === `${twin}_${tool.name}`);
        expect(entry, `${twin}_${tool.name} is missing`).toBeDefined();
        if (!entry || tool.def.type !== "function") throw new Error("unreachable");
        expect(entry.description).toBe(tool.def.function.description);
        expect(entry.inputSchema).toEqual(toInputSchema(tool.def.function.parameters));
        expect(entry.isMutation).toBe(tool.isMutation);
        expect(entry.engineName).toBe(tool.name);
      }
    }
  });

  it("names are unique and self-describing, because the agent sees all three sets at once", () => {
    const names = manifest().entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^(gmail|slack|calendar)_[a-z0-9_]+$/);
    expect(names).toContain("gmail_list_messages");
    expect(names).toContain("slack_send_message");
    expect(names).toContain("calendar_find_free_time");
  });

  it("serves one twin when asked for one twin", () => {
    const only = buildManifest({ config: testConfig, twins: ["gmail"], fetchImpl: fake.fetch });
    expect(only.entries.every((e) => e.twin === "gmail")).toBe(true);
    expect(only.clients.has("slack")).toBe(false);
  });

  it("keeps every input schema an object schema, as tools/list requires", () => {
    for (const tool of toolDescriptors(buildTools({ config: testConfig, fetchImpl: fake.fetch }).entries)) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.description && tool.description.length).toBeGreaterThan(20);
    }
  });

  it("marks reads read-only and mutations destructive", () => {
    const tools = toolDescriptors(buildTools({ config: testConfig, fetchImpl: fake.fetch }).entries);
    const read = tools.find((t) => t.name === "gmail_get_thread");
    const write = tools.find((t) => t.name === "gmail_send_reply");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.destructiveHint).toBe(true);
  });

  it("puts sonata_whats_new first, since it is the tool a plugged-in agent starts with", () => {
    const { entries } = buildTools({ config: testConfig, fetchImpl: fake.fetch });
    expect(entries[0]?.name).toBe("sonata_whats_new");
    expect(entries).toHaveLength(engineNames().length + 1);
  });
});
