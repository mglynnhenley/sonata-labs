import { describe, expect, it } from "vitest";
import { TwinHttpError } from "@sonata/engine/http";
import { twinFailure } from "../src/errors";
import { buildTools, callTool } from "../src/server";
import { refusingFetch, testConfig } from "./fixtures";

// A connector's error text is its real documentation: the user is inside their own
// agent, and the only thing that reaches them is the string in a tool result. So
// every failure has to name the twin, the URL, and the command that fixes it — and
// never a stack trace, which an agent cannot act on and will happily paraphrase as
// "the tool is broken".

function messageOf(result: Awaited<ReturnType<typeof callTool>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text result");
  return first.text;
}

describe("a twin that is not running", () => {
  it("says which twin, where it looked, and how to start it", async () => {
    const { entries, config } = buildTools({
      config: testConfig,
      fetchImpl: refusingFetch(3200),
    });
    const result = await callTool(
      entries,
      "slack_list_channels",
      {},
      (twin) => config.urls[twin],
    );

    expect(result.isError).toBe(true);
    const text = messageOf(result);
    expect(text).toContain("slack twin is not running at http://slack.test");
    expect(text).toContain("npm run dev:slack");
    expect(text).toContain("ECONNREFUSED");
    // No stack trace, no "TypeError:", nothing an agent would quote back as noise.
    expect(text).not.toContain("    at ");
    expect(text).not.toContain("TypeError");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("blames the token, not the network, on a 401", () => {
    const text = twinFailure(
      "gmail",
      "http://gmail.test",
      new TwinHttpError(401, "http://gmail.test/gmail/v1/users/me/messages", "unauthorized"),
    );
    expect(text).toContain("rejected the token");
    expect(text).toContain("SONATA_TOKEN");
    expect(text).not.toContain("npm run dev:gmail");
  });

  it("passes the twin's own words through when the twin answered", () => {
    const text = twinFailure(
      "calendar",
      "http://calendar.test",
      new TwinHttpError(422, "http://calendar.test/calendar/v3/freeBusy", "timeMin required"),
    );
    expect(text).toContain("answered HTTP 422");
    expect(text).toContain("timeMin required");
  });

  it("tells a slow twin apart from a missing one", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const text = twinFailure("gmail", "http://gmail.test", timeout);
    expect(text).toContain("did not answer in time");
    expect(text).toContain("npm run dev:gmail");
  });

  it("keeps the other two surfaces usable when one is down", async () => {
    const { entries, config } = buildTools({
      config: testConfig,
      fetchImpl: refusingFetch(3101),
      twins: ["gmail", "slack", "calendar"],
    });
    const result = await callTool(entries, "sonata_whats_new", {}, (twin) => config.urls[twin]);
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("expected a text result");
    const report = JSON.parse(first.text) as Record<string, { error?: string }>;

    // The poll itself succeeds — an agent that gets a hard failure from its clock
    // stops looking at the clock.
    expect(result.isError).toBeUndefined();
    expect(report.gmail?.error).toContain("gmail twin is not running");
    expect(report.slack?.error).toContain("slack twin is not running");
    expect(report.calendar?.error).toContain("calendar twin is not running");
  });
});
