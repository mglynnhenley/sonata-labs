import type { Person, TwinName, WorldSeed } from "@sonata/core";
import { allTwinApiUrls, owner as ownerOf, resolvePerson, resolveTwinApiUrl } from "@sonata/core";
import type { GeneratedWorld } from "./generate";
import type { CalendarSeed, GmailSeed, SlackSeed } from "./schema";

// ---------------------------------------------------------------------------
// THE SEED CONTRACT — implemented by each twin as `POST /api/sandbox/seed`.
//
//   POST http://127.0.0.1:3101/api/sandbox/seed   (gmail)
//   POST http://127.0.0.1:3200/api/sandbox/seed   (slack)
//   POST http://127.0.0.1:3400/api/sandbox/seed   (calendar)
//   Content-Type: application/json
//   Authorization: Bearer $SANDBOX_TOKEN
//
// Request body, always:
//
//   { "twin": "gmail" | "slack" | "calendar", "seed": <that twin's wire seed> }
//
// `twin` is redundant with the URL on purpose: it makes a mis-routed seed a 400
// instead of a silently empty mailbox.
//
// Every wire seed carries `world` (the shared `WorldSeed` — see @sonata/core) and
// `nowISO` (the instant the relative offsets were resolved against), plus that
// twin's own content. Nothing in a wire seed is relative and nothing needs
// looking up: ids, addresses, absolute timestamps, threading and membership are
// all resolved here, in this file, from the one cast. A twin must NOT invent
// identities of its own — that is exactly how "Priya" in the inbox stops being
// the "Priya" in #ops, which is the whole premise of the product.
//
// A twin should:
//   1. wipe its working DB (equivalent of its existing reset) — seeding is
//      idempotent and total, never additive;
//   2. create an account/user/calendar for every `world.cast` member, using the
//      given `email` / `slackUserId`;
//   3. create the content verbatim, honouring the supplied ids and timestamps;
//   4. leave its snapshot DB alone unless `promoteToSnapshot` is true, in which
//      case the seeded state becomes the state `reset` returns to — that is what
//      makes a cloned business survive a run.
//
// Response body:
//
//   200 { "ok": true,  "counts": { "<thing>": <n>, ... } }
//   4xx { "ok": false, "error": "what went wrong and what to fix" }
//
// `counts` is free-form per twin (gmail: threads/messages/labels; slack:
// channels/messages/users; calendar: calendars/events) and is surfaced in the
// dashboard's clone step, so it should count what was actually written.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

/**
 * Injection talks to the loopback address rather than `localhost`, which can
 * resolve to ::1 while a twin's dev server listens on IPv4 only — a failure that
 * reads as "the twin is down" when it is running fine.
 */
const INJECT_HOST = "127.0.0.1";

export const DEFAULT_TWIN_URLS: Record<TwinName, string> = allTwinApiUrls(
  {},
  { host: INJECT_HOST },
);

/** Env beats the default; an explicit override beats both. Read per call so a
 *  test (or the dashboard's settings page) can move a twin without a restart. */
export function twinBaseUrl(twin: TwinName, overrides?: Partial<Record<TwinName, string>>): string {
  return resolveTwinApiUrl(twin, process.env, {
    host: INJECT_HOST,
    override: overrides?.[twin],
  });
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface WireBase {
  world: WorldSeed;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. */
  promoteToSnapshot: boolean;
}

export interface GmailWireMessage {
  id: string;
  /** RFC 822 `Message-ID`, so threading survives a round trip through MIME. */
  messageIdHeader: string;
  /** The previous message's `messageIdHeader`, or null for the thread opener. */
  inReplyTo: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  dateISO: string;
  body: string;
  /** Per-message labels: the owner's own messages are SENT, not INBOX/UNREAD. */
  labels: string[];
}

export interface GmailWireThread {
  id: string;
  subject: string;
  labels: string[];
  messages: GmailWireMessage[];
}

export interface GmailWireSeed extends WireBase {
  /** `"Priya Raman <priya.raman@northwind.com>"` — whose mailbox this is. */
  ownerAddress: string;
  threads: GmailWireThread[];
}

export interface SlackWireMessage {
  /** Slack's "seconds.micros" id, strictly increasing within a channel. */
  ts: string;
  userId: string;
  text: string;
  /** Parent's `ts` for a threaded reply, null for a top-level message. */
  threadTs: string | null;
}

export interface SlackWireChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  isPrivate: boolean;
  /** Slack user ids. */
  memberIds: string[];
  messages: SlackWireMessage[];
}

export interface SlackWireSeed extends WireBase {
  /** Slack user id of the person whose workspace session the agent uses. */
  ownerUserId: string;
  channels: SlackWireChannel[];
}

export interface CalendarWireAttendee {
  email: string;
  displayName: string;
  responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
  organizer: boolean;
}

export interface CalendarWireEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  startISO: string;
  endISO: string;
  /** RFC 5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. Empty for a one-off. */
  recurrence: string[];
  organizerEmail: string;
  attendees: CalendarWireAttendee[];
}

export interface CalendarWireCalendar {
  id: string;
  summary: string;
  description: string;
  ownerEmail: string;
  timezone: string;
  /** The owner's own calendar — the one a new event lands on by default. */
  primary: boolean;
}

export interface CalendarWireSeed extends WireBase {
  ownerEmail: string;
  calendars: CalendarWireCalendar[];
  events: CalendarWireEvent[];
}

export type WireSeed = GmailWireSeed | SlackWireSeed | CalendarWireSeed;

export interface SeedRequest {
  twin: TwinName;
  seed: WireSeed;
}

export interface SeedResponse {
  ok: boolean;
  counts?: Record<string, number>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Resolution. Pure: seed + instant -> exactly what goes on the wire.
// ---------------------------------------------------------------------------

function address(person: Person): string {
  return `${person.name} <${person.email}>`;
}

function iso(nowMs: number, minutesAgo: number): string {
  return new Date(nowMs - minutesAgo * MINUTE).toISOString();
}

function reSubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function resolveGmailSeed(
  world: WorldSeed,
  seed: GmailSeed,
  nowMs: number,
  promoteToSnapshot = true,
): GmailWireSeed {
  const me = ownerOf(world);
  const domain = me.email.split("@")[1] ?? "sandbox.local";

  const threads = seed.threads.map((thread, ti) => {
    const threadId = `t${String(ti + 1).padStart(2, "0")}`;
    const participants = thread.participants
      .map((id) => resolvePerson(world, id))
      .filter((p): p is Person => !!p);

    let previousHeader: string | null = null;
    const messages = thread.messages.map((message, mi) => {
      const from = resolvePerson(world, message.fromPersonId) ?? me;
      const id = `${threadId}-m${mi + 1}`;
      const header = `<${id}@${domain}>`;
      const recipients = participants.filter((p) => p.id !== from.id);
      const mine = from.id === me.id;

      // The owner's own messages read as SENT; only inbound mail lands unread in
      // the inbox. Deriving this rather than letting the model set it is what
      // stops a "clone" where the owner's replies show up as unread mail to them.
      const labels = mine
        ? ["SENT"]
        : thread.labels.filter((l) => l !== "SENT");

      const wire: GmailWireMessage = {
        id,
        messageIdHeader: header,
        inReplyTo: previousHeader,
        from: address(from),
        to: mine ? recipients.map(address) : [address(me)],
        cc: mine ? [] : recipients.filter((p) => p.id !== me.id).map(address),
        subject: mi === 0 ? thread.subject : reSubject(thread.subject),
        dateISO: iso(nowMs, message.minutesAgo),
        body: message.body,
        labels,
      };
      previousHeader = header;
      return wire;
    });

    return { id: threadId, subject: thread.subject, labels: thread.labels, messages };
  });

  return {
    world,
    nowISO: new Date(nowMs).toISOString(),
    promoteToSnapshot,
    ownerAddress: address(me),
    threads,
  };
}

function formatTs(seconds: number, micros: number): string {
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

/**
 * Slack's `ts` is both the message id and the sort key, and it must strictly
 * increase within a channel — a reused ts reads as a duplicate to every client.
 * Several seeded messages routinely share a minute, so a ts that would not
 * advance is bumped by one microsecond, exactly as the Slack twin's own
 * `mintTs` does.
 */
function nextTs(ms: number, previous: string | null): string {
  const seconds = Math.floor(ms / 1000);
  let micros = (ms % 1000) * 1000;
  if (previous) {
    const [ps, pu] = previous.split(".");
    if (Number(ps) > seconds) return formatTs(Number(ps), Number(pu) + 1);
    if (Number(ps) === seconds && micros <= Number(pu)) micros = Number(pu) + 1;
  }
  return micros >= 1_000_000
    ? formatTs(seconds + 1, micros - 1_000_000)
    : formatTs(seconds, micros);
}

export function resolveSlackSeed(
  world: WorldSeed,
  seed: SlackSeed,
  nowMs: number,
  promoteToSnapshot = true,
): SlackWireSeed {
  const me = ownerOf(world);
  const byName = new Map(world.channels.map((c) => [c.name, c]));

  const channels = seed.channels.map((channel, ci) => {
    const declared = byName.get(channel.name);
    const stem = channel.name.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8);
    const id = declared?.id ?? `C${String(ci + 1).padStart(2, "0")}${stem}`;
    // Flatten before minting so ts comes out in true chronological order: a
    // reply written after a later top-level message still has to sort after it.
    // `parent` is the index of the top-level message a reply belongs to.
    const flat = channel.messages.flatMap((message, mi) => [
      {
        personId: message.personId,
        minutesAgo: message.minutesAgo,
        text: message.text,
        parent: -1,
        index: mi,
      },
      ...(message.threadReplies ?? []).map((reply) => ({
        personId: reply.personId,
        minutesAgo: reply.minutesAgo,
        text: reply.text,
        parent: mi,
        index: -1,
      })),
    ]);
    flat.sort((a, b) => b.minutesAgo - a.minutesAgo);

    const messages: SlackWireMessage[] = [];
    const parentTs = new Map<number, string>();
    let previous: string | null = null;
    for (const entry of flat) {
      const from = resolvePerson(world, entry.personId);
      if (!from) continue;
      const ts = nextTs(nowMs - entry.minutesAgo * MINUTE, previous);
      previous = ts;
      if (entry.parent < 0) parentTs.set(entry.index, ts);
      messages.push({
        ts,
        userId: from.slackUserId,
        text: entry.text,
        threadTs: entry.parent < 0 ? null : (parentTs.get(entry.parent) ?? null),
      });
    }

    return {
      id,
      name: channel.name,
      topic: channel.topic,
      purpose: channel.purpose,
      isPrivate: declared?.isPrivate ?? false,
      memberIds: channel.members
        .map((personId) => resolvePerson(world, personId)?.slackUserId)
        .filter((sid): sid is string => !!sid),
      messages,
    };
  });

  return {
    world,
    nowISO: new Date(nowMs).toISOString(),
    promoteToSnapshot,
    ownerUserId: me.slackUserId,
    channels,
  };
}

export function resolveCalendarSeed(
  world: WorldSeed,
  seed: CalendarSeed,
  nowMs: number,
  promoteToSnapshot = true,
): CalendarWireSeed {
  const me = ownerOf(world);
  const timezone = world.timezone ?? "UTC";

  const calendars = seed.calendars.map((calendar, i) => {
    const calOwner = resolvePerson(world, calendar.ownerPersonId) ?? me;
    const primary = i === 0;
    const shared = `${calendar.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@group.calendar.local`;
    return {
      // A person's primary calendar is addressed by their email in the Google
      // API, so keeping that identity here means an agent's "calendarId: me"
      // resolves to the same thing the seed created.
      id: primary ? calOwner.email : shared,
      summary: calendar.name,
      description: calendar.description,
      ownerEmail: calOwner.email,
      timezone,
      primary,
    };
  });
  const byName = new Map(seed.calendars.map((c, i) => [c.name, calendars[i]]));

  const events = seed.events.map((event, i) => {
    const calendar = byName.get(event.calendarName) ?? calendars[0];
    const organizer = world.cast.find((p) => p.email === calendar.ownerEmail) ?? me;
    const start = nowMs + event.startOffsetMin * MINUTE;
    const attendees = event.attendeePersonIds
      .map((id) => resolvePerson(world, id))
      .filter((p): p is Person => !!p)
      .map((p) => ({
        email: p.email,
        displayName: p.name,
        // Seeded history is settled history: RSVPs the episode wants to be open
        // are set by a beat, not smuggled in through the world.
        responseStatus: "accepted" as const,
        organizer: p.email === organizer.email,
      }));

    return {
      id: `evt-${String(i + 1).padStart(3, "0")}`,
      calendarId: calendar.id,
      summary: event.summary,
      description: event.description ?? "",
      location: event.location ?? "",
      startISO: new Date(start).toISOString(),
      endISO: new Date(start + event.durationMin * MINUTE).toISOString(),
      recurrence: event.recurrence ? [event.recurrence] : [],
      organizerEmail: organizer.email,
      attendees,
    };
  });

  return {
    world,
    nowISO: new Date(nowMs).toISOString(),
    promoteToSnapshot,
    ownerEmail: me.email,
    calendars,
    events,
  };
}

/**
 * The exact body posted to one twin. Exported so a caller can dry-run it.
 *
 * Four twins throw rather than return, and the throw is the honest answer: a
 * `GeneratedWorld` carries a mailbox, a workspace and a diary and nothing else,
 * so there is no CRM, no document set, no ad account and no feed to resolve into
 * a wire seed. The alternative — an empty seed — would post successfully, wipe
 * whatever the twin held, and leave the agent working a surface the story says
 * is full. That failure surfaces as a badly behaved agent hours later; this one
 * surfaces as a sentence naming the twin.
 */
export function buildSeedRequest(
  generated: GeneratedWorld,
  twin: TwinName,
  nowMs: number,
  promoteToSnapshot = true,
): SeedRequest {
  const { world } = generated;
  switch (twin) {
    case "gmail":
      return { twin, seed: resolveGmailSeed(world, generated.gmail, nowMs, promoteToSnapshot) };
    case "slack":
      return { twin, seed: resolveSlackSeed(world, generated.slack, nowMs, promoteToSnapshot) };
    case "calendar":
      return {
        twin,
        seed: resolveCalendarSeed(world, generated.calendar, nowMs, promoteToSnapshot),
      };
    case "attio":
    case "google-docs":
    case "google-ads":
    case "linkedin":
      throw new Error(
        `World generation does not cover the ${twin} twin yet: a generated world holds a ` +
          `mailbox, a Slack workspace and a diary, and nothing that could be seeded into ` +
          `${twin}. Leave it out of the run's twins, or seed it out of band and run with ` +
          `seedWorld: false.`,
      );
  }
}

// ---------------------------------------------------------------------------
// The HTTP part
// ---------------------------------------------------------------------------

/** Every twin's sandbox routes sit behind this static bearer token — see each
 *  app's `auth.ts`, and @sonata/engine's `http.ts`, which reads the same env. */
export const DEFAULT_SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

export interface InjectOptions {
  /** Which twins to seed. Defaults to all three. */
  twins?: TwinName[];
  baseUrls?: Partial<Record<TwinName, string>>;
  /** Bearer token for the twins' sandbox routes. Defaults to `SANDBOX_TOKEN`. */
  token?: string;
  /** The instant relative offsets resolve against. Defaults to `Date.now()`. */
  now?: number;
  /** Make the seeded state what `reset` returns to. Defaults to true. */
  promoteToSnapshot?: boolean;
  /** Injected for tests and for a proxied environment. */
  fetch?: typeof globalThis.fetch;
  say?: (msg: string) => void;
}

export interface InjectResult {
  twin: TwinName;
  url: string;
  ok: boolean;
  /** 0 when the twin could not be reached at all. */
  status: number;
  counts?: Record<string, number>;
  error?: string;
}

export interface InjectReport {
  ok: boolean;
  nowISO: string;
  results: InjectResult[];
}

/**
 * Load a generated world into the running twins. Never writes another app's
 * SQLite: every twin owns its own storage and is only ever addressed through its
 * HTTP surface, so seeding stays honest about what the twins can actually do.
 *
 * Never throws for an unreachable or unhappy twin — the dashboard needs to show
 * "Slack isn't running" next to two green ticks, not a stack trace.
 */
export async function injectWorld(
  generated: GeneratedWorld,
  opts: InjectOptions = {},
): Promise<InjectReport> {
  const twins = opts.twins ?? (["gmail", "slack", "calendar"] as TwinName[]);
  const nowMs = opts.now ?? Date.now();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const say = opts.say ?? (() => {});
  const results: InjectResult[] = [];

  // Sequential on purpose: three twins hitting three SQLite files in parallel
  // buys nothing, and a failure order that matches the log is worth more.
  for (const twin of twins) {
    const url = `${twinBaseUrl(twin, opts.baseUrls)}/api/sandbox/seed`;
    // A twin this generator cannot build a seed for is reported like any other
    // failure rather than thrown out of the whole load: the other surfaces still
    // get their world, and the caller — `loadClone` — still refuses to start a
    // run on a report that is not ok. The dashboard shows which one and why.
    let body: SeedRequest;
    try {
      body = buildSeedRequest(generated, twin, nowMs, opts.promoteToSnapshot ?? true);
    } catch (err) {
      results.push({ twin, url, ok: false, status: 0, error: (err as Error).message });
      continue;
    }
    say(`seeding ${twin} at ${url}`);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.token ?? DEFAULT_SANDBOX_TOKEN}`,
          // Two spellings because the twins disagree about which they read, and
          // a seed that 401s is the least useful failure this can produce.
          "x-sandbox-token": opts.token ?? DEFAULT_SANDBOX_TOKEN,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: SeedResponse | undefined;
      try {
        parsed = text ? (JSON.parse(text) as SeedResponse) : undefined;
      } catch {
        parsed = undefined;
      }
      results.push({
        twin,
        url,
        ok: res.ok && parsed?.ok !== false,
        status: res.status,
        ...(parsed?.counts ? { counts: parsed.counts } : {}),
        ...(res.ok && parsed?.ok !== false
          ? {}
          : { error: parsed?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}` }),
      });
    } catch (err) {
      results.push({
        twin,
        url,
        ok: false,
        status: 0,
        error: `${(err as Error).message} — is the ${twin} twin running?`,
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    nowISO: new Date(nowMs).toISOString(),
    results,
  };
}
