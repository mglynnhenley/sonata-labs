import { twinFailure } from "./errors";
import type { McpToolEntry, ObjectSchema } from "./manifest";
import type { ServedTwin } from "./config";

// `sonata_whats_new` — the tool that makes polling practical.
//
// A plugged-in agent is long-lived and the world is not waiting for it: mail
// arrives, a channel gets loud, a meeting moves, all on the world's own clock.
// Without a cheap "since I last looked" the agent has two bad options — re-read
// every inbox and channel on every poll (expensive, and it re-reads the same
// thing forever), or read nothing and miss the day. This tool is the third
// option, and it is why an external agent can be idle without being asleep.
//
// It is composed ENTIRELY out of the twin tools in the manifest — list_messages,
// get_message, list_channels, get_channel_history, list_events — rather than out
// of a private endpoint. Two reasons: nothing new for the twins to implement, and
// nothing the agent could not have done itself, so noticing carries no
// information the agent was not entitled to. It is a shortcut, not an oracle.

/** Inbox ids scanned per poll. Deltas are small; the list is only to spot them. */
const GMAIL_SCAN = 40;

/** Channels scanned per poll — a workspace of dozens would make polling expensive again. */
const SLACK_CHANNELS = 12;

const SLACK_HISTORY = 20;

/** Items reported per twin unless the caller asks for more. */
const DEFAULT_MAX = 10;

const MAX_ITEMS = 50;

/** How far ahead the calendar is scanned by default. A week is what "coming up" means. */
const CALENDAR_DAYS_AHEAD = 14;

const CALENDAR_DAYS_BACK = 1;

const DAY_MS = 86_400_000;

const SNIPPET = 240;

interface GmailListResult {
  messages?: Array<{ id?: string; threadId?: string }>;
}

interface GmailMessageResult {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  date?: string;
  labelIds?: string[];
  body?: string;
}

interface SlackChannelsResult {
  channels?: Array<{ id?: string; name?: string }>;
}

interface SlackHistoryResult {
  messages?: Array<{ ts?: string; user?: string; text?: string; threadTs?: string }>;
}

interface CalendarEventsResult {
  events?: Array<{
    id?: string;
    summary?: string;
    start?: string;
    end?: string;
    status?: string;
    organizer?: string;
  }>;
}

interface CalendarMemo {
  fingerprint: string;
  startMs: number;
  summary: string;
  start: string;
}

interface Cursor {
  gmailSeen: Set<string>;
  gmailPrimed: boolean;
  slackLastTs: Map<string, number>;
  slackPrimed: boolean;
  calendarSeen: Map<string, CalendarMemo>;
  calendarPrimed: boolean;
}

function newCursor(): Cursor {
  return {
    gmailSeen: new Set(),
    gmailPrimed: false,
    slackLastTs: new Map(),
    slackPrimed: false,
    calendarSeen: new Map(),
    calendarPrimed: false,
  };
}

const SCHEMA: ObjectSchema = {
  type: "object",
  properties: {
    maxPerTwin: {
      type: "integer",
      description: "How many new items to report per surface. Default 10.",
    },
    twins: {
      type: "array",
      items: { type: "string", enum: ["gmail", "slack", "calendar"] },
      description: "Limit the check to these surfaces. Defaults to all of them.",
    },
    timeMin: {
      type: "string",
      description: "RFC3339 start of the calendar window. Defaults to yesterday.",
    },
    timeMax: {
      type: "string",
      description: "RFC3339 end of the calendar window. Defaults to two weeks out.",
    },
  },
};

const DESCRIPTION =
  "What has changed since you last looked, across mail, Slack and the calendar: new " +
  "messages, new channel posts, and events that were added, moved or cancelled. Cheap " +
  "enough to call on a loop — the first call establishes the baseline and later calls " +
  "return only what is new. Call it, then use the per-surface tools to read anything it " +
  "flags.";

export interface WhatsNewArgs {
  maxPerTwin?: number;
  twins?: string[];
  timeMin?: string;
  timeMax?: string;
}

/** Per-surface report. `error` is set instead of the payload when that twin is down. */
export interface TwinReport {
  error?: string;
  [key: string]: unknown;
}

export interface WhatsNewResult {
  checkedAt: string;
  /** True when this call only established the baseline — nothing here is necessarily new. */
  firstLook: boolean;
  nothingNew: boolean;
  gmail?: TwinReport;
  slack?: TwinReport;
  calendar?: TwinReport;
}

function clamp(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function requestedTwins(args: WhatsNewArgs, available: ServedTwin[]): ServedTwin[] {
  if (!Array.isArray(args.twins) || args.twins.length === 0) return available;
  const asked = new Set(args.twins.map((t) => String(t).toLowerCase()));
  return available.filter((t) => asked.has(t));
}

export interface WhatsNewOptions {
  entries: McpToolEntry[];
  baseUrlFor(twin: ServedTwin): string;
  /** Injectable so a test does not depend on the wall clock. */
  now?: () => Date;
}

/**
 * Build the tool. It closes over a cursor, so it is per-connection state: a
 * reconnecting agent gets one more "first look" rather than a silent gap, which
 * is the right way round — a repeated item costs a token, a missed one costs the
 * day.
 */
export function createWhatsNewTool(opts: WhatsNewOptions): McpToolEntry {
  const now = opts.now ?? (() => new Date());
  const cursor = newCursor();
  const byName = new Map(opts.entries.map((e) => [e.name, e]));
  const available = (["gmail", "slack", "calendar"] as const).filter((twin) =>
    opts.entries.some((e) => e.twin === twin),
  );

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const entry = byName.get(name);
    if (!entry) throw new Error(`tool ${name} is not served by this connector`);
    return (await entry.run(args)) as T;
  }

  async function gmailDelta(max: number): Promise<TwinReport> {
    const list = await call<GmailListResult>("gmail_list_messages", {
      labelIds: ["INBOX"],
      maxResults: GMAIL_SCAN,
    });
    const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    const fresh = ids.filter((id) => !cursor.gmailSeen.has(id));
    for (const id of ids) cursor.gmailSeen.add(id);
    const firstLook = !cursor.gmailPrimed;
    cursor.gmailPrimed = true;

    // The list comes back newest-first, so the cap sheds the oldest unseen mail
    // rather than the newest — an agent that can only look at three things should
    // be looking at the three that just landed.
    const show = fresh.slice(0, max);
    const messages: Array<Record<string, unknown>> = [];
    for (const id of show) {
      const msg = await call<GmailMessageResult>("gmail_get_message", { messageId: id });
      messages.push({
        id: msg.id ?? id,
        threadId: msg.threadId,
        from: msg.from ?? "",
        subject: msg.subject ?? "",
        date: msg.date ?? "",
        unread: (msg.labelIds ?? []).includes("UNREAD"),
        snippet: (msg.body ?? "").slice(0, SNIPPET),
      });
    }
    return {
      newMessages: messages,
      newCount: fresh.length,
      omitted: Math.max(fresh.length - show.length, 0),
      inboxScanned: ids.length,
      ...(firstLook ? { note: "First look: this is the inbox as it stands, not new arrivals." } : {}),
    };
  }

  async function slackDelta(max: number): Promise<TwinReport> {
    const list = await call<SlackChannelsResult>("slack_list_channels", {});
    const channels = (list.channels ?? []).slice(0, SLACK_CHANNELS);
    const firstLook = !cursor.slackPrimed;
    cursor.slackPrimed = true;

    const posts: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const channel of channels) {
      const id = channel.id;
      if (!id) continue;
      const history = await call<SlackHistoryResult>("slack_get_channel_history", {
        channel: id,
        limit: SLACK_HISTORY,
      });
      const seenTs = cursor.slackLastTs.get(id) ?? 0;
      let high = seenTs;
      const fresh: Array<Record<string, unknown>> = [];
      for (const m of history.messages ?? []) {
        const ts = Number(m.ts ?? 0);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (ts > high) high = ts;
        // On a first look every message is "new", which would dump the whole
        // workspace. The baseline call reports nothing and just remembers where
        // the water line is; the next call is the one that means something.
        if (!firstLook && ts > seenTs) {
          fresh.push({
            channel: channel.name ?? id,
            channelId: id,
            ts: m.ts,
            user: m.user ?? "",
            text: (m.text ?? "").slice(0, SNIPPET),
            ...(m.threadTs ? { threadTs: m.threadTs } : {}),
          });
        }
      }
      cursor.slackLastTs.set(id, high);
      total += fresh.length;
      posts.push(...fresh);
    }

    posts.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    const show = posts.slice(-max);
    return {
      newMessages: show,
      newCount: total,
      omitted: Math.max(total - show.length, 0),
      channelsScanned: channels.length,
      ...(firstLook
        ? { note: "First look: the water line is set. Later calls report only what arrives after it." }
        : {}),
    };
  }

  async function calendarDelta(max: number, args: WhatsNewArgs): Promise<TwinReport> {
    const at = now().getTime();
    const timeMin = args.timeMin ?? new Date(at - CALENDAR_DAYS_BACK * DAY_MS).toISOString();
    const timeMax = args.timeMax ?? new Date(at + CALENDAR_DAYS_AHEAD * DAY_MS).toISOString();
    const res = await call<CalendarEventsResult>("calendar_list_events", {
      timeMin,
      timeMax,
      maxResults: 50,
    });
    const firstLook = !cursor.calendarPrimed;
    cursor.calendarPrimed = true;

    const windowFrom = Date.parse(timeMin);
    const windowTo = Date.parse(timeMax);
    const added: Array<Record<string, unknown>> = [];
    const changed: Array<Record<string, unknown>> = [];
    const present = new Set<string>();

    for (const e of res.events ?? []) {
      const id = e.id;
      if (!id) continue;
      present.add(id);
      const fingerprint = `${e.start ?? ""}|${e.end ?? ""}|${e.summary ?? ""}|${e.status ?? ""}`;
      const memo = cursor.calendarSeen.get(id);
      const item = {
        id,
        summary: e.summary ?? "",
        start: e.start ?? "",
        end: e.end ?? "",
        status: e.status ?? "",
        organizer: e.organizer ?? "",
      };
      if (!memo) {
        if (!firstLook) added.push(item);
      } else if (memo.fingerprint !== fingerprint) {
        changed.push({ ...item, was: { start: memo.start, summary: memo.summary } });
      }
      cursor.calendarSeen.set(id, {
        fingerprint,
        startMs: Date.parse(e.start ?? "") || 0,
        summary: e.summary ?? "",
        start: e.start ?? "",
      });
    }

    // Only events that WERE in this window and are no longer there count as gone.
    // Without that guard, narrowing the window would report half the calendar as
    // cancelled — and a false cancellation is the one thing an assistant must not
    // tell anyone.
    const removed: Array<Record<string, unknown>> = [];
    for (const [id, memo] of cursor.calendarSeen) {
      if (present.has(id)) continue;
      const inWindow = memo.startMs >= windowFrom && memo.startMs <= windowTo;
      if (inWindow && !firstLook) removed.push({ id, summary: memo.summary, start: memo.start });
      if (inWindow) cursor.calendarSeen.delete(id);
    }

    return {
      added: added.slice(0, max),
      changed: changed.slice(0, max),
      removed: removed.slice(0, max),
      window: { timeMin, timeMax },
      ...(firstLook ? { note: "First look: the calendar as it stands, held as the baseline." } : {}),
    };
  }

  async function guarded(twin: ServedTwin, work: () => Promise<TwinReport>): Promise<TwinReport> {
    try {
      return await work();
    } catch (err) {
      // One twin being down must not blind the agent to the other two: a poll that
      // fails whole is a poll an agent stops making.
      return { error: twinFailure(twin, opts.baseUrlFor(twin), err) };
    }
  }

  return {
    name: "sonata_whats_new",
    // Reported against gmail only for the failure-message plumbing; the tool
    // itself spans every served twin and reports each one's trouble in place.
    twin: available[0] ?? "gmail",
    engineName: "whats_new",
    description: DESCRIPTION,
    inputSchema: SCHEMA,
    isMutation: false,
    async run(rawArgs: Record<string, unknown>): Promise<WhatsNewResult> {
      const args = rawArgs as WhatsNewArgs;
      const max = clamp(args.maxPerTwin, DEFAULT_MAX, MAX_ITEMS);
      const wanted = requestedTwins(args, available);
      const firstLook = wanted.some(
        (t) =>
          (t === "gmail" && !cursor.gmailPrimed) ||
          (t === "slack" && !cursor.slackPrimed) ||
          (t === "calendar" && !cursor.calendarPrimed),
      );

      const result: WhatsNewResult = {
        checkedAt: now().toISOString(),
        firstLook,
        nothingNew: false,
      };
      if (wanted.includes("gmail")) result.gmail = await guarded("gmail", () => gmailDelta(max));
      if (wanted.includes("slack")) result.slack = await guarded("slack", () => slackDelta(max));
      if (wanted.includes("calendar")) {
        result.calendar = await guarded("calendar", () => calendarDelta(max, args));
      }

      const counts = [
        count(result.gmail?.newCount),
        count(result.slack?.newCount),
        count(result.calendar?.added),
        count(result.calendar?.changed),
        count(result.calendar?.removed),
      ];
      result.nothingNew = counts.every((n) => n === 0);
      return result;
    },
  };
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : 0;
}
