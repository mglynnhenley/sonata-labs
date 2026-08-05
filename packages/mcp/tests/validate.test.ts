import { describe, expect, it } from "vitest";
import { buildTools, callTool } from "../src/server";
import { validateArgs } from "../src/validate";
import type { ObjectSchema } from "../src/manifest";
import { fetchFake, testConfig } from "./fixtures";

// Both cases below were found by driving the real server over stdio against the
// real twins, not imagined: `gmail_get_message` called with `id` instead of
// `messageId` came back HTTP 200 with every field blank, and `gmail_modify_labels`
// the same way came back HTTP 405 with an empty body. Neither is a twin bug —
// `str(undefined)` is `""`, so both requests went out with an empty path segment
// and the twin answered the URL it was actually given.

function messageOf(result: Awaited<ReturnType<typeof callTool>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text result");
  return first.text;
}

const schema: ObjectSchema = {
  type: "object",
  properties: {
    messageId: { type: "string" },
    maxResults: { type: "integer" },
    labelIds: { type: "array", items: { type: "string" } },
  },
  required: ["messageId"],
};

describe("validateArgs", () => {
  it("passes a call that supplies what the schema requires", () => {
    expect(validateArgs("gmail_get_message", schema, { messageId: "abc" })).toBeNull();
  });

  it("names the missing argument and lists the real ones", () => {
    const why = validateArgs("gmail_get_message", schema, { id: "abc" });
    expect(why).toContain('requires "messageId"');
    expect(why).toContain("You passed id");
    expect(why).toContain("Accepted arguments: messageId, maxResults, labelIds");
  });

  it("treats an empty string id as missing, because it produces the silent wrong answer", () => {
    expect(validateArgs("gmail_get_message", schema, { messageId: "  " })).toContain("empty");
  });

  it("rejects a wrong primitive type", () => {
    const why = validateArgs("gmail_get_message", schema, { messageId: "a", maxResults: "ten" });
    expect(why).toContain('expects "maxResults" to be a integer');
  });

  it("accepts an integer where a number is asked for, and vice versa", () => {
    const nums: ObjectSchema = { type: "object", properties: { n: { type: "number" } } };
    expect(validateArgs("t", nums, { n: 3 })).toBeNull();
  });

  it("ignores unknown keys, which MCP clients add and the engine drops", () => {
    expect(validateArgs("gmail_get_message", schema, { messageId: "a", _meta: 1 })).toBeNull();
  });

  it("does not second-guess a schema that declares no type", () => {
    const loose: ObjectSchema = { type: "object", properties: { anything: {} } };
    expect(validateArgs("t", loose, { anything: { nested: true } })).toBeNull();
  });
});

describe("the server refuses the call rather than letting the twin answer it", () => {
  it("never reaches the twin when a required argument is missing", async () => {
    const fake = fetchFake({ "/messages/": { payload: {} } });
    const { entries, config } = buildTools({ config: testConfig, fetchImpl: fake.fetch });

    // The exact call that used to come back 200 with every field blank.
    const result = await callTool(entries, "gmail_get_message", { id: "abc" }, (t) => config.urls[t]);

    expect(result.isError).toBe(true);
    expect(messageOf(result)).toContain('gmail_get_message requires "messageId"');
    // The point of validating first: no request was made at all, so there is no
    // empty-path URL for the twin to answer plausibly.
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses modify_labels the same way instead of sending an empty path segment", async () => {
    const fake = fetchFake({});
    const { entries, config } = buildTools({ config: testConfig, fetchImpl: fake.fetch });

    const result = await callTool(
      entries,
      "gmail_modify_labels",
      { id: "abc", removeLabelIds: ["UNREAD"] },
      (t) => config.urls[t],
    );

    expect(result.isError).toBe(true);
    expect(messageOf(result)).toContain('requires "messageId"');
    expect(fake.calls).toHaveLength(0);
  });

  it("still lets a correct call through to the twin", async () => {
    const fake = fetchFake({ "/messages/abc": { id: "abc", threadId: "t1", payload: {} } });
    const { entries, config } = buildTools({ config: testConfig, fetchImpl: fake.fetch });

    const result = await callTool(
      entries,
      "gmail_get_message",
      { messageId: "abc" },
      (t) => config.urls[t],
    );

    expect(result.isError).toBeUndefined();
    expect(fake.find("/messages/abc")).toBeDefined();
  });
});
