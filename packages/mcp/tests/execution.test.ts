import { describe, expect, it } from "vitest";
import { buildTools, callTool } from "../src/server";
import { fetchFake, gmailMessage, testConfig } from "./fixtures";
import type { Call } from "./fixtures";

// What actually goes on the wire. The connector's promise is that a tool call
// from an outside agent hits the same twin route the benchmark hits, with the
// bearer token attached — so these tests read the request, not the result.

function harness(routes: Record<string, unknown>) {
  const fake = fetchFake(routes);
  const { entries, config } = buildTools({ config: testConfig, fetchImpl: fake.fetch });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    callTool(entries, name, args, (twin) => config.urls[twin]);
  return { fake, call };
}

function payload(result: Awaited<ReturnType<typeof callTool>>): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text result");
  return JSON.parse(first.text);
}

function text(result: Awaited<ReturnType<typeof callTool>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text result");
  return first.text;
}

describe("tool execution", () => {
  it("sends a Gmail read to the twin's own route, with the bearer token", async () => {
    const { fake, call } = harness({
      "/messages": { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 },
    });
    const result = await call("gmail_list_messages", { labelIds: ["INBOX"], maxResults: 5 });

    const sent = fake.find("/messages") as Call;
    expect(sent.method).toBe("GET");
    expect(sent.url).toBe(
      "http://gmail.test/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=5",
    );
    expect(sent.headers.Authorization).toBe("Bearer test-token");
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({ messages: [{ id: "m1", threadId: "t1" }], total: 1 });
  });

  it("resolves a Slack channel name before posting, so an agent can say 'ops'", async () => {
    const { fake, call } = harness({
      "/api/conversations.list": { ok: true, channels: [{ id: "C01OPS", name: "ops" }] },
      "/api/chat.postMessage": { ok: true, ts: "1738.0002", channel: "C01OPS" },
    });
    const result = await call("slack_send_message", { channel: "#ops", text: "on it" });

    expect(fake.find("/api/chat.postMessage")?.body).toEqual({
      channel: "C01OPS",
      text: "on it",
    });
    expect(payload(result)).toEqual({ ts: "1738.0002", channel: "C01OPS", posted: true });
  });

  it("composes a reply into RFC822 and sends it on the original's thread", async () => {
    const { fake, call } = harness({
      "/profile": { emailAddress: "priya@northwind.test" },
      "/messages/m1": gmailMessage({ id: "m1", from: "dana@acme.test", subject: "Freight" }),
      "/messages/send": { id: "s1", threadId: "t-m1" },
    });
    await call("gmail_send_reply", { messageId: "m1", body: "Landing tomorrow." });

    const sent = fake.find("/messages/send")?.body as { raw: string; threadId: string };
    expect(sent.threadId).toBe("t-m1");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(raw).toContain("From: priya@northwind.test");
    expect(raw).toContain("To: dana@acme.test");
    expect(raw).toContain("Subject: Re: Freight");
    expect(raw).toContain("Landing tomorrow.");
  });

  it("asks the calendar for busy blocks and hands back free ones", async () => {
    const { fake, call } = harness({
      "/users/me/calendarList": { items: [{ id: "priya@northwind.test", primary: true }] },
      "/freeBusy": {
        calendars: {
          "priya@northwind.test": {
            busy: [{ start: "2026-08-04T10:00:00Z", end: "2026-08-04T11:00:00Z" }],
          },
        },
      },
    });
    const result = await call("calendar_find_free_time", {
      timeMin: "2026-08-04T09:00:00Z",
      timeMax: "2026-08-04T12:00:00Z",
      durationMinutes: 30,
    });

    const sent = fake.find("/freeBusy") as Call;
    expect(sent.method).toBe("POST");
    expect(sent.headers["Content-Type"]).toBe("application/json");
    expect(payload(result)).toEqual({
      free: [
        { start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T10:00:00.000Z" },
        { start: "2026-08-04T11:00:00.000Z", end: "2026-08-04T12:00:00.000Z" },
      ],
    });
  });

  it("names the tools it does have when asked for one it does not", async () => {
    const { call } = harness({});
    const result = await call("gmail_delete_everything", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No Sonata tool called "gmail_delete_everything"');
    expect(text(result)).toContain("gmail_list_messages");
  });
});
