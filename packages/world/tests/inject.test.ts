import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TWIN_NAMES } from "@sonata/core";
import { assembleWorld } from "../src/generate";
import {
  buildSeedRequest,
  injectWorld,
  resolveAttioSeed,
  resolveCalendarSeed,
  resolveGmailSeed,
  resolveGoogleAdsSeed,
  resolveGoogleDocsSeed,
  resolveLinkedInSeed,
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

describe("resolveAttioSeed", () => {
  const wire = resolveAttioSeed(built.world, built.attio, NOW);

  it("puts the whole cast in the workspace, because that is who can own a deal", () => {
    expect(wire.members.map((m) => m.email)).toEqual(built.world.cast.map((p) => p.email));
    expect(wire.members.find((m) => m.email.startsWith("priya"))!.accessLevel).toBe("admin");
    expect(wire.workspace.slug).toBe("northwind-ledger");
  });

  it("addresses records by minted id, and points every reference at one", () => {
    const vantage = wire.companies.find((c) => c.name === "Vantage Freight")!;
    // Scheme, www and path all stripped: the twin stores a hostname.
    expect(vantage.domains).toEqual(["vantagefreight.com"]);
    const deal = wire.deals[0];
    expect(deal.companyId).toBe(vantage.id);
    expect(deal.ownerEmail).toBe("priya.raman@northwindledger.com");
    expect(deal.peopleIds).toEqual([wire.people[0].id]);
    expect(wire.notes[0].parentRecordId).toBe(deal.id);
    expect(wire.notes[0].createdISO).toBe(new Date(NOW - 300 * 60_000).toISOString());
    expect(wire.tasks[0].linkedRecords).toEqual([{ object: "deals", recordId: deal.id }]);
  });

  it("dates a deadline absolutely, so an overdue task is still overdue tomorrow", () => {
    // The fixture's task was due two hours BEFORE the world's instant.
    expect(wire.tasks[0].deadlineAt).toBe(new Date(NOW - 120 * 60_000).toISOString());
  });

  it("mints the same ids for the same world, so yesterday's artifact still resolves", () => {
    expect(resolveAttioSeed(built.world, built.attio, NOW)).toEqual(wire);
  });
});

describe("resolveGoogleDocsSeed", () => {
  const wire = resolveGoogleDocsSeed(built.world, built.googleDocs, NOW);

  it("gives every document a Google-shaped id and a cast member for an owner", () => {
    expect(wire.documents).toHaveLength(1);
    expect(wire.documents[0].id).toMatch(/^[A-Za-z0-9_-]{44}$/);
    // The fixture's owner is nobody, so the document falls to the mailbox owner.
    expect(wire.documents[0].ownerEmail).toBe("priya.raman@northwindledger.com");
  });

  it("carries one paragraph per line, with the style only on the first", () => {
    const paragraphs = wire.documents[0].paragraphs;
    expect(paragraphs.map((p) => p.text)).toEqual([
      "Evidence tracker",
      "Outstanding",
      "Restore test — TBC",
    ]);
    expect(paragraphs[0].namedStyleType).toBe("TITLE");
    expect(paragraphs[1].namedStyleType).toBe("HEADING_1");
    expect(paragraphs[2].namedStyleType).toBeUndefined();
  });
});

describe("resolveGoogleAdsSeed", () => {
  const wire = resolveGoogleAdsSeed(built.world, built.googleAds, NOW);

  it("mints decimal ids and funds every campaign, because a budget is required", () => {
    expect(wire.customer.id).toMatch(/^[1-9]\d{9}$/);
    expect(wire.customer.timezone).toBe("America/New_York");
    expect(wire.budgets).toHaveLength(wire.campaigns.length);
    expect(wire.budgets[0].amountMicros).toBe(250_000_000);
    expect(wire.campaigns[0].budgetId).toBe(wire.budgets[0].id);
    expect(wire.campaigns[0].advertisingChannelType).toBe("SEARCH");
    expect(wire.adGroups[0].type).toBe("SEARCH_STANDARD");
  });

  it("expands one typical day into a month of dated rows, yesterday backwards", () => {
    const rows = wire.dailyStats.filter((r) => r.adGroupId === wire.adGroups[0].id);
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.date)).size).toBe(30);
    // LAST_7_DAYS does not include today, so history stops at yesterday.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
      new Date(NOW),
    );
    expect(rows.some((r) => r.date === today)).toBe(false);
    // The normalizer already capped clicks at impressions; the wobble keeps it.
    expect(rows.every((r) => r.clicks <= r.impressions)).toBe(true);
    expect(rows.every((r) => r.costMicros % 1_000_000 === 0)).toBe(true);
  });

  it("is deterministic, so a report run twice returns the same numbers", () => {
    expect(resolveGoogleAdsSeed(built.world, built.googleAds, NOW)).toEqual(wire);
  });

  it("still funds an account for a company that advertises nothing", () => {
    // The twin refuses a seed carrying no budget at all, so a world with no
    // campaigns has to arrive with an empty account rather than a broken one.
    const quiet = resolveGoogleAdsSeed(built.world, { campaigns: [] }, NOW);
    expect(quiet.campaigns).toEqual([]);
    expect(quiet.dailyStats).toEqual([]);
    expect(quiet.budgets).toHaveLength(1);
    expect(quiet.budgets[0].amountMicros).toBe(100_000_000);
  });
});

describe("resolveLinkedInSeed", () => {
  const wire = resolveLinkedInSeed(built.world, built.linkedin, NOW);

  it("gives every cast member an identity and the owner the page", () => {
    expect(wire.members.map((m) => m.personId)).toEqual(["priya", "marcus", "gerald"]);
    expect(wire.members.find((m) => m.personId === "priya")!.pageAdmin).toBe(true);
    expect(wire.organization.vanityName).toBe("northwind-ledger");
  });

  it("posts as the page when nobody in the cast wrote it", () => {
    const [post] = wire.posts;
    expect(post.authorKind).toBe("organization");
    expect(post.authorEmail).toBeUndefined();
    expect(post.id).toMatch(/^[1-9]\d{11}$/);
    expect(post.publishedISO).toBe(new Date(NOW - 2000 * 60_000).toISOString());
  });

  it("keeps a thread one level deep and dates every reply after its parent", () => {
    const [comment] = wire.posts[0].comments;
    expect(comment.actorEmail).toBe("gerald.pike@halloranpike.com");
    // Depth two was flattened up beside its parent, and the reply that claimed
    // to predate the comment it answers was pulled back to it.
    expect(comment.replies).toHaveLength(2);
    expect(comment.replies!.every((r) => !r.replies)).toBe(true);
    expect(comment.replies![0].createdISO).toBe(new Date(NOW - 1000 * 60_000).toISOString());
    const ids = wire.posts.flatMap((p) => p.comments.flatMap((c) => [c.id, ...(c.replies ?? []).map((r) => r.id)]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves a draft unpublished and unengaged, which is the only state it can be in", () => {
    const draft = wire.posts.find((p) => p.lifecycleState === "DRAFT")!;
    expect(draft.comments).toEqual([]);
    expect(draft.reactions).toEqual([]);
  });

  it("reacts once per person, and only for people the page has heard of", () => {
    expect(wire.posts[0].reactions.map((r) => r.actorEmail)).toEqual([
      "marcus.bell@northwindledger.com",
    ]);
    expect(wire.posts[0].reactions[0].reactionType).toBe("LIKE");
  });
});

describe("buildSeedRequest", () => {
  it("is pure: the same world and instant build the same body", () => {
    expect(buildSeedRequest(built, "gmail", NOW)).toEqual(buildSeedRequest(built, "gmail", NOW));
  });

  it("labels the body with the twin it is for, so a mis-route is a 400", () => {
    for (const twin of TWIN_NAMES) {
      const request = buildSeedRequest(built, twin, NOW);
      expect(request.twin).toBe(twin);
      // Every twin gets the whole shared world — that is what stops three twins
      // inventing three different Priyas.
      expect(request.seed.world.cast.map((p) => p.id)).toEqual(["priya", "marcus", "gerald"]);
      expect(request.seed.promoteToSnapshot).toBe(true);
    }
  });

  // Seeding is total: a twin takes the whole surface or nothing, so an empty
  // seed would POST successfully, wipe whatever the twin held, and leave the
  // agent working an empty CRM inside a story that says it is full. Every twin
  // therefore resolves something, and every one of them resolves it from the
  // same cast.
  it("builds a real seed for every twin, out of the one world", () => {
    for (const twin of TWIN_NAMES) {
      const seed = buildSeedRequest(built, twin, NOW).seed;
      expect(seed.nowISO).toBe(new Date(NOW).toISOString());
      expect(seed.world.cast.map((p) => p.id)).toEqual(["priya", "marcus", "gerald"]);
    }
  });

  // A world record is JSON on disk and outlives the type it was written from: a
  // company cloned when a backlog was a mailbox, a workspace and a diary has
  // nothing to say about the CRM. The same refusal as an unwriteable seed, for
  // the same reason — an empty one would post, wipe the twin, and leave the
  // agent working a surface the story says is full — but it names the fix.
  it("refuses a stored world that predates a surface, and says how to fix it", () => {
    const { attio: _attio, ...legacy } = built;
    expect(() => buildSeedRequest(legacy as typeof built, "attio", NOW)).toThrow(
      /cloned before the attio twin existed/,
    );
    // The surfaces it does carry are untouched: one missing seed is one twin's
    // problem, not a company that can no longer be loaded anywhere.
    expect(buildSeedRequest(legacy as typeof built, "gmail", NOW).twin).toBe("gmail");
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

  it("reports a world that cannot be resolved at all, and still seeds the rest", async () => {
    seen.length = 0;
    // A time zone that is not a zone. Every ads date is resolved in it, so the
    // ads seed cannot be built — and that is a line in the report rather than a
    // stack trace out of the whole load.
    const broken = { ...built, world: { ...built.world, timezone: "Mars/Phobos" } };
    const report = await injectWorld(broken, {
      twins: ["gmail", "google-ads"],
      baseUrls: { gmail: base, "google-ads": base },
      now: NOW,
    });

    expect(seen.map((s) => s.body.twin)).toEqual(["gmail"]);
    expect(report.ok).toBe(false);
    const ads = report.results.find((r) => r.twin === "google-ads")!;
    expect(ads.status).toBe(0);
    expect(ads.error).toContain("Mars/Phobos");
    expect(report.results.find((r) => r.twin === "gmail")!.ok).toBe(true);
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
