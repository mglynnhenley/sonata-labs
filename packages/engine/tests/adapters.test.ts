import { describe, it, expect } from "vitest";
import type { InjectContext, InjectedRef } from "@sonata/core";
import { createGmailAdapter } from "../src/adapters/gmail";
import { createSlackAdapter } from "../src/adapters/slack";
import { createCalendarAdapter } from "../src/adapters/calendar";
import { normalizeAudit, seedBodyFor } from "../src/adapters/shared";
import { fetchFake, spec, world } from "./fixtures";

// These assertions are the contract between this package and apps/*. Each one
// pins the request the adapter actually puts on the wire against the shape the
// twin's own route parses — the failure they exist to catch is silent: a route
// that 400s or, worse, 200s while ignoring the body.

const at = "2026-08-04T09:15:00.000Z";

function ctx(refs: Record<string, InjectedRef> = {}): InjectContext {
  return { atISO: at, world, resolve: (ref) => refs[ref] };
}

describe("the gmail adapter", () => {
  it("injects through POST /api/sandbox/inject in the shape that route parses", async () => {
    const fake = fetchFake({
      "/api/sandbox/inject": { ok: true, injected: { twin: "gmail", id: "m1", containerId: "t1" } },
    });
    const adapter = createGmailAdapter({ baseUrl: "http://gmail.test", fetchImpl: fake.fetch });

    const handle = await adapter.inject(
      {
        twin: "gmail",
        kind: "email",
        payload: {
          from: "dana",
          to: ["priya"],
          cc: ["sam"],
          subject: "Where is my freight",
          body: "Well?",
          inReplyTo: "opener",
        },
      },
      ctx({ opener: { twin: "gmail", id: "m0", containerId: "t0" } }),
    );

    const call = fake.find("/api/sandbox/inject");
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({
      kind: "email",
      from: "Dana Reyes <dana@acme.test>",
      to: ["Priya Raman <priya@northwind.test>"],
      cc: ["Sam Okafor <sam@northwind.test>"],
      subject: "Where is my freight",
      body: "Well?",
      // Simulated time on the wire, not an offset from the wall clock.
      atISO: at,
      threadRef: "m0",
    });
    expect(handle).toEqual({ twin: "gmail", id: "m1", containerId: "t1" });
  });

  it("posts standalone when the named beat never landed", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": { ok: true, injected: { id: "m1" } } });
    const adapter = createGmailAdapter({ baseUrl: "http://gmail.test", fetchImpl: fake.fetch });
    await adapter.inject(
      {
        twin: "gmail",
        kind: "email",
        payload: { from: "dana", to: ["priya"], subject: "s", body: "b", inReplyTo: "missing" },
      },
      ctx(),
    );
    expect(fake.find("/api/sandbox/inject")?.body).not.toHaveProperty("threadRef");
  });

  it("carries the sandbox token on every request", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": { injected: { id: "m1" } } });
    const adapter = createGmailAdapter({
      baseUrl: "http://gmail.test",
      token: "hunter2",
      fetchImpl: fake.fetch,
    });
    await adapter.inject(
      { twin: "gmail", kind: "email", payload: { from: "dana", to: ["priya"], subject: "s", body: "b" } },
      ctx(),
    );
    const headers = fake.find("/api/sandbox/inject")?.headers ?? {};
    expect(headers.Authorization).toBe("Bearer hunter2");
    expect(headers["X-Sandbox-Token"]).toBe("hunter2");
  });

  it("refuses another twin's beat rather than posting it somewhere wrong", async () => {
    const adapter = createGmailAdapter({ baseUrl: "http://gmail.test", fetchImpl: fetchFake({}).fetch });
    await expect(
      adapter.inject(
        { twin: "slack", kind: "message", payload: { channel: "ops", from: "sam", text: "hi" } },
        ctx(),
      ),
    ).rejects.toThrow(/cannot inject a slack beat/);
  });

  it("reads its audit log with the parameters that route accepts", async () => {
    const fake = fetchFake({
      "/api/activity": {
        actions: [
          { id: 2, ts: 20, method: "POST", endpoint: "/send", summary: "Sent" },
          { id: 1, ts: 10, method: "POST", endpoint: "/modify", summary: "Labelled" },
        ],
      },
    });
    const adapter = createGmailAdapter({ baseUrl: "http://gmail.test", fetchImpl: fake.fetch });
    const rows = await adapter.auditSince(1);

    expect(fake.find("/api/activity")?.url).toContain("sinceId=1");
    expect(fake.find("/api/activity")?.url).toContain("limit=1000");
    // Ascending, and everything at or below the cursor filtered out.
    expect(rows.map((r) => r.id)).toEqual([2]);
  });
});

describe("the slack adapter", () => {
  it("injects one event, not a batch, and names the kind the route expects", async () => {
    const fake = fetchFake({
      "/api/sandbox/inject": { ok: true, injected: { twin: "slack", id: "1720.01", containerId: "C01OPS" } },
    });
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fake.fetch });

    const handle = await adapter.inject(
      { twin: "slack", kind: "message", payload: { channel: "#ops", from: "sam", text: "on it" } },
      ctx(),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toEqual({
      kind: "message",
      channel: "ops",
      user: "U03SAM",
      text: "on it",
      atISO: at,
    });
    expect(handle).toEqual({ twin: "slack", id: "1720.01", containerId: "C01OPS" });
    // The route resolves channel names itself, so no roster lookup goes out.
    expect(fake.calls.some((c) => c.url.includes("conversations.list"))).toBe(false);
  });

  it("posts a threaded reply as thread_reply, which is its own kind", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": { injected: { id: "1720.02", containerId: "C01OPS" } } });
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fake.fetch });
    await adapter.inject(
      {
        twin: "slack",
        kind: "message",
        payload: { channel: "ops", from: "sam", text: "still on it", threadRef: "root" },
      },
      ctx({ root: { twin: "slack", id: "1720.01", containerId: "C01OPS" } }),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toMatchObject({
      kind: "thread_reply",
      threadTs: "1720.01",
    });
  });

  it("reacts on the message the ref names, in that message's own channel", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": { injected: { id: "1720.01", containerId: "C01OPS" } } });
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fake.fetch });
    const handle = await adapter.inject(
      { twin: "slack", kind: "reaction", payload: { messageRef: "root", from: "sam", emoji: "eyes" } },
      ctx({ root: { twin: "slack", id: "1720.01", containerId: "C01OPS" } }),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toEqual({
      kind: "reaction",
      channel: "C01OPS",
      ts: "1720.01",
      user: "U03SAM",
      emoji: "eyes",
      atISO: at,
    });
    // A reaction has no id of its own; the handle points back at what it decorated.
    expect(handle).toEqual({ twin: "slack", id: "1720.01", containerId: "C01OPS" });
  });

  it("splits the channel off an audit-log ref before using it as a ts", async () => {
    // A ref minted from the twin's own audit log is Slack's `target_id` —
    // "C01OPS/1720.01", one string. Passing that whole thing back as a threadTs
    // is a 400, which is the world silently unable to answer the agent.
    const fake = fetchFake({ "/api/sandbox/inject": { injected: { id: "1720.09", containerId: "C01OPS" } } });
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fake.fetch });
    await adapter.inject(
      {
        twin: "slack",
        kind: "message",
        payload: { channel: "ops", from: "sam", text: "seen", threadRef: "act:slack:11" },
      },
      ctx({ "act:slack:11": { twin: "slack", id: "C01OPS/1720.01" } }),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toMatchObject({
      kind: "thread_reply",
      threadTs: "1720.01",
    });

    const react = fetchFake({ "/api/sandbox/inject": { injected: {} } });
    const handle = await createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: react.fetch }).inject(
      { twin: "slack", kind: "reaction", payload: { messageRef: "act:slack:11", from: "sam", emoji: "eyes" } },
      ctx({ "act:slack:11": { twin: "slack", id: "C01OPS/1720.01" } }),
    );
    expect(react.find("/api/sandbox/inject")?.body).toMatchObject({ channel: "C01OPS", ts: "1720.01" });
    expect(handle).toEqual({ twin: "slack", id: "1720.01", containerId: "C01OPS" });
  });

  it("says what is missing when a reaction points at nothing", async () => {
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fetchFake({}).fetch });
    await expect(
      adapter.inject(
        { twin: "slack", kind: "reaction", payload: { messageRef: "ghost", from: "sam", emoji: "eyes" } },
        ctx(),
      ),
    ).rejects.toThrow(/which nothing created/);
  });

  it("explains a missing inject route rather than falling back to chat.postMessage", async () => {
    const adapter = createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: fetchFake({}).fetch });
    await expect(
      adapter.inject(
        { twin: "slack", kind: "message", payload: { channel: "ops", from: "sam", text: "hi" } },
        ctx(),
      ),
    ).rejects.toThrow(/no POST \/api\/sandbox\/inject route/);
  });
});

describe("the calendar adapter", () => {
  it("places an invite through the events branch of the inject route", async () => {
    const fake = fetchFake({
      "/api/sandbox/inject": { inserted: [{ slotId: "s", id: "ev1", calendarId: "cal1" }] },
    });
    const adapter = createCalendarAdapter({ baseUrl: "http://cal.test", fetchImpl: fake.fetch });
    const handle = await adapter.inject(
      {
        twin: "calendar",
        kind: "invite",
        payload: {
          title: "SLA review",
          organizer: "priya",
          attendees: ["dana"],
          startISO: "2026-08-04T14:00:00Z",
          endISO: "2026-08-04T14:30:00Z",
        },
      },
      ctx(),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toEqual({
      events: [
        {
          summary: "SLA review",
          start: { dateTime: "2026-08-04T14:00:00Z" },
          end: { dateTime: "2026-08-04T14:30:00Z" },
          organizer: { email: "priya@northwind.test" },
          attendees: [
            { email: "dana@acme.test", displayName: "Dana Reyes", responseStatus: "needsAction" },
          ],
        },
      ],
    });
    expect(handle).toEqual({ twin: "calendar", id: "ev1", containerId: "cal1" });
  });

  it("moves and cancels through the branches that route has", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": { moved: [], cancelled: [] } });
    const adapter = createCalendarAdapter({ baseUrl: "http://cal.test", fetchImpl: fake.fetch });
    const refs = { review: { twin: "calendar" as const, id: "ev1", containerId: "cal1" } };

    await adapter.inject(
      {
        twin: "calendar",
        kind: "move",
        payload: { eventRef: "review", startISO: "2026-08-04T15:00:00Z", endISO: "2026-08-04T15:30:00Z" },
      },
      ctx(refs),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toEqual({
      moves: [
        {
          eventId: "ev1",
          calendarId: "cal1",
          start: { dateTime: "2026-08-04T15:00:00Z" },
          end: { dateTime: "2026-08-04T15:30:00Z" },
        },
      ],
    });

    await adapter.inject(
      { twin: "calendar", kind: "cancel", payload: { eventRef: "review" } },
      ctx(refs),
    );
    expect(fake.find("/api/sandbox/inject")?.body).toEqual({
      cancels: [{ eventId: "ev1", calendarId: "cal1" }],
    });
  });

  it("fails an rsvp loudly, because that route has no branch for one", async () => {
    const fake = fetchFake({ "/api/sandbox/inject": {} });
    const adapter = createCalendarAdapter({ baseUrl: "http://cal.test", fetchImpl: fake.fetch });
    await expect(
      adapter.inject(
        {
          twin: "calendar",
          kind: "rsvp",
          payload: { eventRef: "review", who: "dana", response: "declined" },
        },
        ctx({ review: { twin: "calendar", id: "ev1", containerId: "cal1" } }),
      ),
    ).rejects.toThrow(/not rsvps/);
    // And it fails before writing anything, rather than half-applying.
    expect(fake.calls).toHaveLength(0);
  });

  it("seeds the cast and the owner's primary calendar, and no events", async () => {
    const fake = fetchFake({ "/api/sandbox/seed": { ok: true } });
    const adapter = createCalendarAdapter({ baseUrl: "http://cal.test", fetchImpl: fake.fetch });
    await adapter.seed(spec());
    expect(fake.find("/api/sandbox/seed")?.body).toEqual(seedBodyFor("calendar", spec()));
  });
});

describe("seeding", () => {
  it("builds the body each twin's parseSeedRequest actually accepts", () => {
    expect(seedBodyFor("gmail", spec())).toEqual({
      twin: "gmail",
      seed: { profileEmail: "priya@northwind.test", labels: [], messages: [] },
    });

    expect(seedBodyFor("slack", spec())).toEqual({
      twin: "slack",
      seed: {
        self: "U01PRIYA",
        users: [
          { id: "U01PRIYA", realName: "Priya Raman", email: "priya@northwind.test", title: "Head of Support" },
          { id: "U02DANA", realName: "Dana Reyes", email: "dana@acme.test", title: "Ops Lead at Acme" },
          { id: "U03SAM", realName: "Sam Okafor", email: "sam@northwind.test", title: "Dispatcher" },
        ],
        channels: [
          {
            id: "C01OPS",
            name: "ops",
            purpose: "the day's freight",
            isPrivate: false,
            // Members arrive as cast ids and go out as Slack ids: the twin has
            // never heard of "priya".
            members: ["U01PRIYA", "U03SAM"],
          },
        ],
        messages: [],
      },
    });

    // The calendar takes only the wire shape, so its cast-only seed is a wire
    // seed with an empty day: identities and the primary calendar, no events.
    expect(seedBodyFor("calendar", spec())).toEqual({
      twin: "calendar",
      seed: {
        world,
        nowISO: "2026-08-04T09:00:00.000Z",
        promoteToSnapshot: true,
        ownerEmail: "priya@northwind.test",
        calendars: [
          {
            id: "priya@northwind.test",
            summary: "Priya Raman",
            description: "Priya Raman's calendar at Northwind Logistics",
            ownerEmail: "priya@northwind.test",
            timezone: "UTC",
            primary: true,
          },
        ],
        events: [],
      },
    });
  });

  it("posts the seed to the right route and explains a twin that has none", async () => {
    const ok = fetchFake({ "/api/sandbox/seed": { ok: true } });
    await createGmailAdapter({ baseUrl: "http://gmail.test", fetchImpl: ok.fetch }).seed(spec());
    expect(ok.find("/api/sandbox/seed")?.body).toEqual(seedBodyFor("gmail", spec()));

    const missing = fetchFake({});
    await expect(
      createSlackAdapter({ baseUrl: "http://slack.test", fetchImpl: missing.fetch }).seed(spec()),
    ).rejects.toThrow(/no POST \/api\/sandbox\/seed route/);
  });
});

describe("normalizeAudit", () => {
  it("turns each twin's own row shape into the one the director reads, ascending", () => {
    const rows = normalizeAudit("slack", [
      { id: 3, ts: 30, method: "POST", endpoint: "/api/chat.postMessage", action_type: "post", target_type: "message", target_id: "1720.03", summary: "Posted" },
      { id: 1, summary: "Reacted" },
      { notAnId: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
    expect(rows[1]).toEqual({
      id: 3,
      twin: "slack",
      ts: 30,
      method: "POST",
      endpoint: "/api/chat.postMessage",
      actionType: "post",
      targetType: "message",
      targetId: "1720.03",
      summary: "Posted",
    });
    expect(normalizeAudit("gmail", undefined)).toEqual([]);
  });
});
