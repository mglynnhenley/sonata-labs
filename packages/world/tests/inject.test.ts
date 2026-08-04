import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleWorld } from "../src/generate";
import {
  buildSeedRequest,
  injectWorld,
  resolveCalendarSeed,
  resolveGmailSeed,
  resolveSlackSeed,
  twinBaseUrl,
  type SeedRequest,
} from "../src/inject";
import { DRAFT, NOW, SEEDS } from "./fixtures";

// No twin has to be running: a local http server stands in for all three, the
// same way apps/gmail's llm-wire test stands in for OpenRouter. What is being
// pinned is the wire contract — what gets posted where, and that a twin that is
// down is reported rather than thrown.

const built = assembleWorld("a fintech before an audit", DRAFT, SEEDS, { now: NOW });
const OWNER = "Priya Raman <priya.raman@northwindledger.com>";

describe("resolveGmailSeed", () => {
  const wire = resolveGmailSeed(built.world, built.gmail, NOW);

  it("addresses everything from the one cast", () => {
    expect(wire.ownerAddress).toBe(OWNER);
    const soc = wire.threads.find((t) => t.subject.includes("SOC 2"))!;
    expect(soc.messages[0].from).toBe("Gerald Pike <gerald.pike@halloranpike.com>");
    expect(soc.messages[0].to).toEqual([OWNER]);
  });

  it("threads with Message-ID headers rather than hoping subjects match", () => {
    const soc = wire.threads.find((t) => t.subject.includes("SOC 2"))!;
    expect(soc.messages[0].inReplyTo).toBeNull();
    expect(soc.messages[1].inReplyTo).toBe(soc.messages[0].messageIdHeader);
    expect(soc.messages[2].inReplyTo).toBe(soc.messages[1].messageIdHeader);
    expect(new Set(soc.messages.map((m) => m.messageIdHeader)).size).toBe(soc.messages.length);
  });

  it("files the owner's own messages as SENT, and the rest as they came in", () => {
    const soc = wire.threads.find((t) => t.subject.includes("SOC 2"))!;
    const mine = soc.messages.find((m) => m.from === OWNER)!;
    expect(mine.labels).toEqual(["SENT"]);
    expect(mine.to).not.toContain(OWNER);
    expect(soc.messages[0].labels).toEqual(["INBOX", "UNREAD", "Audit"]);
  });

  it("dates every message from the injected instant, never the wall clock", () => {
    const soc = wire.threads.find((t) => t.subject.includes("SOC 2"))!;
    expect(soc.messages[0].dateISO).toBe(new Date(NOW - 2800 * 60_000).toISOString());
    expect(soc.messages[1].subject.startsWith("Re: ")).toBe(true);
    expect(wire.nowISO).toBe(new Date(NOW).toISOString());
  });
});

describe("resolveSlackSeed", () => {
  const wire = resolveSlackSeed(built.world, built.slack, NOW);
  const channel = wire.channels[0];

  it("uses the world's own channel id and Slack user ids", () => {
    expect(channel.id).toBe(built.world.channels[0].id);
    expect(channel.memberIds).toEqual(["U01PRIYA", "U03GERALD", "U02MARCUS"]);
    expect(wire.ownerUserId).toBe("U01PRIYA");
  });

  it("mints a strictly increasing ts, because a repeat reads as a duplicate", () => {
    const timestamps = channel.messages.map((m) => Number(m.ts));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(channel.messages.map((m) => m.ts)).size).toBe(channel.messages.length);
  });

  it("hangs a reply off its parent's ts", () => {
    const parent = channel.messages.find((m) => m.text.includes("auditors"))!;
    const reply = channel.messages.find((m) => m.text.includes("confirm the room"))!;
    expect(parent.threadTs).toBeNull();
    expect(reply.threadTs).toBe(parent.ts);
    expect(Number(reply.ts)).toBeGreaterThan(Number(parent.ts));
  });
});

describe("resolveCalendarSeed", () => {
  const wire = resolveCalendarSeed(built.world, built.calendar, NOW);

  it("addresses the owner's primary calendar by their email, as Google does", () => {
    expect(wire.ownerEmail).toBe("priya.raman@northwindledger.com");
    expect(wire.calendars[0].primary).toBe(true);
    expect(wire.calendars[0].id).toBe("priya.raman@northwindledger.com");
    expect(wire.calendars[0].timezone).toBe("America/New_York");
  });

  it("turns offsets into instants and attendees into addresses", () => {
    const fieldwork = wire.events.find((e) => e.summary === "Fieldwork day 1")!;
    expect(fieldwork.startISO).toBe(new Date(NOW + 5760 * 60_000).toISOString());
    expect(fieldwork.endISO).toBe(new Date(NOW + (5760 + 480) * 60_000).toISOString());
    expect(fieldwork.attendees.map((a) => a.email)).toEqual([
      "priya.raman@northwindledger.com",
      "gerald.pike@halloranpike.com",
    ]);
    expect(fieldwork.attendees[0].organizer).toBe(true);
    // The fixture's lowercase "freq=weekly" is not a rule; the daily one is.
    expect(fieldwork.recurrence).toEqual([]);
    expect(wire.events.find((e) => e.summary === "Standup")!.recurrence).toEqual([
      "RRULE:FREQ=DAILY",
    ]);
  });
});

describe("buildSeedRequest", () => {
  it("is pure: the same world and instant build the same body", () => {
    expect(buildSeedRequest(built, "gmail", NOW)).toEqual(buildSeedRequest(built, "gmail", NOW));
  });

  it("labels the body with the twin it is for, so a mis-route is a 400", () => {
    for (const twin of ["gmail", "slack", "calendar"] as const) {
      const request = buildSeedRequest(built, twin, NOW);
      expect(request.twin).toBe(twin);
      // Every twin gets the whole shared world — that is what stops three twins
      // inventing three different Priyas.
      expect(request.seed.world.cast.map((p) => p.id)).toEqual(["priya", "marcus", "gerald"]);
      expect(request.seed.promoteToSnapshot).toBe(true);
    }
  });
});

describe("twinBaseUrl", () => {
  it("prefers an explicit override, then env, then the default port", () => {
    expect(twinBaseUrl("gmail")).toBe("http://127.0.0.1:3101");
    expect(twinBaseUrl("slack", { slack: "http://example.test:9/" })).toBe("http://example.test:9");
    process.env.SONATA_CALENDAR_URL = "http://127.0.0.1:9999";
    expect(twinBaseUrl("calendar")).toBe("http://127.0.0.1:9999");
    delete process.env.SONATA_CALENDAR_URL;
  });
});

describe("injectWorld over HTTP", () => {
  let server: Server;
  let base = "";
  const seen: { url: string; method: string; contentType: string; body: SeedRequest }[] = [];
  let failNext: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as SeedRequest;
        seen.push({
          url: req.url ?? "",
          method: req.method ?? "",
          contentType: String(req.headers["content-type"]),
          body,
        });
        if (failNext && body.twin === failNext) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unknown label: Audit" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, counts: { threads: body.twin === "gmail" ? 2 : 0 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("posts one JSON body per twin to /api/sandbox/seed", async () => {
    seen.length = 0;
    const report = await injectWorld(built, {
      baseUrls: { gmail: base, slack: base, calendar: base },
      now: NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.nowISO).toBe(new Date(NOW).toISOString());
    expect(seen.map((s) => s.url)).toEqual([
      "/api/sandbox/seed",
      "/api/sandbox/seed",
      "/api/sandbox/seed",
    ]);
    expect(seen.map((s) => s.method)).toEqual(["POST", "POST", "POST"]);
    expect(seen.map((s) => s.contentType)).toEqual(Array(3).fill("application/json"));
    expect(seen.map((s) => s.body.twin)).toEqual(["gmail", "slack", "calendar"]);
    expect(report.results[0].counts).toEqual({ threads: 2 });
  });

  it("seeds only the twins asked for", async () => {
    seen.length = 0;
    const report = await injectWorld(built, {
      twins: ["slack"],
      baseUrls: { slack: base },
      now: NOW,
    });
    expect(seen.map((s) => s.body.twin)).toEqual(["slack"]);
    expect(report.results).toHaveLength(1);
  });

  it("reports a twin that answers with an error instead of throwing", async () => {
    failNext = "slack";
    const report = await injectWorld(built, {
      baseUrls: { gmail: base, slack: base, calendar: base },
      now: NOW,
    });
    failNext = null;

    expect(report.ok).toBe(false);
    const slack = report.results.find((r) => r.twin === "slack")!;
    expect(slack.status).toBe(400);
    expect(slack.error).toBe("unknown label: Audit");
    // The other two still ran: the dashboard shows two ticks and one problem.
    expect(report.results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("says which twin is not running rather than surfacing a socket error", async () => {
    const report = await injectWorld(built, {
      twins: ["calendar"],
      baseUrls: { calendar: "http://127.0.0.1:1" },
      now: NOW,
      fetch: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe(0);
    expect(report.results[0].error).toContain("is the calendar twin running?");
    expect(report.results[0].url).toBe("http://127.0.0.1:1/api/sandbox/seed");
  });

  it("reports progress for the dashboard's seeding step", async () => {
    const lines: string[] = [];
    await injectWorld(built, {
      twins: ["gmail"],
      baseUrls: { gmail: base },
      now: NOW,
      say: (m) => lines.push(m),
    });
    expect(lines).toEqual([`seeding gmail at ${base}/api/sandbox/seed`]);
  });
});
