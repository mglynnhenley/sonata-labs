import { describe, expect, it } from "vitest";
import { buildTools } from "../src/server";
import type { WhatsNewResult } from "../src/whatsNew";
import { fetchFake, gmailMessage, testConfig, type Call } from "./fixtures";

// The tool that makes polling practical. The whole test is the second call: an
// agent that is told about the same twelve emails every thirty seconds is an agent
// that will stop reading them.

const NOW = new Date("2026-08-04T09:00:00Z");

/** A world that can change between two polls. */
function world() {
  const inbox = [gmailMessage({ id: "m1", subject: "Freight delay" })];
  const posts = [{ ts: "1000.0001", user: "U03SAM", text: "morning" }];
  const events = [
    {
      id: "e1",
      summary: "Ops standup",
      start: { dateTime: "2026-08-04T09:30:00Z" },
      end: { dateTime: "2026-08-04T09:45:00Z" },
      status: "confirmed",
    },
  ];

  const fake = fetchFake({
    "/gmail/v1/users/me/messages": () => ({
      messages: inbox.map((m) => ({ id: m.id, threadId: m.threadId })),
      resultSizeEstimate: inbox.length,
    }),
    "/gmail/v1/users/me/messages/": (call: Call) => {
      const id = call.url.split("/messages/")[1]?.split("?")[0] ?? "";
      return inbox.find((m) => m.id === id) ?? { error: "not found" };
    },
    "/api/conversations.list": { ok: true, channels: [{ id: "C01OPS", name: "ops" }] },
    "/api/conversations.history": () => ({ ok: true, messages: [...posts].reverse() }),
    "/calendar/v3/users/me/calendarList": {
      items: [{ id: "priya@northwind.test", primary: true }],
    },
    "/events": () => ({ items: events }),
  });

  const { entries, config } = buildTools({
    config: testConfig,
    fetchImpl: fake.fetch,
    now: () => NOW,
  });
  const tool = entries.find((e) => e.name === "sonata_whats_new");
  if (!tool) throw new Error("sonata_whats_new is not in the manifest");

  return {
    fake,
    config,
    poll: (args: Record<string, unknown> = {}) => tool.run(args) as Promise<WhatsNewResult>,
    inbox,
    posts,
    events,
  };
}

describe("sonata_whats_new", () => {
  it("establishes a baseline first, then reports only what arrived", async () => {
    const w = world();

    const first = await w.poll();
    expect(first.firstLook).toBe(true);
    expect(first.checkedAt).toBe(NOW.toISOString());
    // The baseline shows the inbox as it stands and says so, rather than pretending
    // a mailbox the agent has never seen is all new.
    expect(first.gmail?.newMessages).toHaveLength(1);
    expect(first.gmail?.note).toContain("First look");
    expect(first.slack?.newMessages).toEqual([]);

    const quiet = await w.poll();
    expect(quiet.firstLook).toBe(false);
    expect(quiet.nothingNew).toBe(true);
    expect(quiet.gmail?.newMessages).toEqual([]);

    w.inbox.unshift(gmailMessage({ id: "m2", subject: "Refund, now" }));
    w.posts.push({ ts: "1000.0002", user: "U01PRIYA", text: "dana is on the phone" });
    w.events.push({
      id: "e2",
      summary: "Client call",
      start: { dateTime: "2026-08-04T14:00:00Z" },
      end: { dateTime: "2026-08-04T14:30:00Z" },
      status: "confirmed",
    });

    const third = await w.poll();
    expect(third.nothingNew).toBe(false);
    expect(third.gmail?.newMessages).toMatchObject([{ id: "m2", subject: "Refund, now" }]);
    expect(third.slack?.newMessages).toMatchObject([
      { channel: "ops", ts: "1000.0002", text: "dana is on the phone" },
    ]);
    expect(third.calendar?.added).toMatchObject([{ id: "e2", summary: "Client call" }]);
  });

  it("notices a meeting that moved, and one that was cancelled", async () => {
    const w = world();
    await w.poll();

    w.events[0]!.start = { dateTime: "2026-08-04T11:00:00Z" };
    const moved = await w.poll();
    expect(moved.calendar?.changed).toMatchObject([
      { id: "e1", start: "2026-08-04T11:00:00Z", was: { start: "2026-08-04T09:30:00Z" } },
    ]);

    w.events.length = 0;
    const gone = await w.poll();
    expect(gone.calendar?.removed).toMatchObject([{ id: "e1", summary: "Ops standup" }]);

    // And it stays gone: a cancellation reported twice is a second phone call to a
    // client who already knows.
    const after = await w.poll();
    expect(after.calendar?.removed).toEqual([]);
  });

  it("reads one twin when asked for one twin", async () => {
    const w = world();
    await w.poll();
    const gmailCalls = w.fake.all("/gmail").length;
    const only = await w.poll({ twins: ["slack"] });

    expect(only.gmail).toBeUndefined();
    expect(only.calendar).toBeUndefined();
    expect(only.slack?.channelsScanned).toBe(1);
    // Not "reported nothing from Gmail" — did not ask Gmail at all.
    expect(w.fake.all("/gmail")).toHaveLength(gmailCalls);
  });

  it("caps what it reports and says how much it held back", async () => {
    const w = world();
    for (let i = 0; i < 6; i += 1) w.inbox.unshift(gmailMessage({ id: `n${i}` }));
    const first = await w.poll({ maxPerTwin: 2 });

    expect(first.gmail?.newMessages).toHaveLength(2);
    expect(first.gmail?.newCount).toBe(7);
    expect(first.gmail?.omitted).toBe(5);
  });
});
