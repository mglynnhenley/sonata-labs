import type { Database } from "better-sqlite3";
import { getSelf } from "../store/meta";
import { listConversations, getConversation, isMember, listMembers } from "../store/conversations";
import { getHistory, getReplies, getMessage } from "../store/messages";
import { listUsers, getUser, shapeUser } from "../store/users";
import { getReactionsFor } from "../store/reactions";
import { getFilesForMessage } from "../store/files";
import { isPinned } from "../store/pins";
import { unreadCounts, markAllRead } from "../store/read-state";
import { tsToMs } from "../slack/ts";
import type { ConversationRow, MessageRow } from "../slack/types";

// View models for the UI routes. Deliberately denormalized (author names,
// avatars, reaction pills resolved server-side) so the client can render
// without extra lookups, and shaped for the Slack layout: author-grouped
// messages, day dividers, thread teasers.

export interface UiUser {
  id: string;
  name: string;
  realName: string;
  initials: string;
  color: string;
  isBot: boolean;
}

// Deterministic avatar tint from the user id (Slack assigns per-user colors).
const AVATAR_COLORS = [
  "#E8912D", "#3B7DBF", "#4BA1A8", "#DE5C8E", "#7C6BB8",
  "#5A9E4B", "#C1554B", "#8C6D46", "#4A8FA8", "#B0447F",
];

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function uiUser(db: Database, id: string | null, botId?: string | null): UiUser {
  if (!id) {
    // Bot/app messages carry bot_id instead of user. Slack sends the display
    // name in the message's `username` field; callers that have the row should
    // prefer uiAuthor(), which reads it. This is the last-resort fallback.
    const fallbackId = botId ?? "bot";
    return {
      id: fallbackId,
      name: "bot",
      realName: "Bot",
      initials: "BO",
      color: tintFor(fallbackId),
      isBot: true,
    };
  }
  const row = getUser(db, id);
  const realName = row?.real_name || row?.name || id;
  const name = row?.name || id;
  return {
    id,
    name,
    realName,
    initials: initialsOf(realName),
    color: tintFor(id),
    isBot: !!row?.is_bot,
  };
}

/**
 * Author for a stored message. Handles the bot case: bot messages have
 * user = NULL and bot_id set, with the display name in raw_json.username
 * (exactly how Slack delivers app messages).
 */
export function uiAuthor(db: Database, row: MessageRow): UiUser {
  if (row.user) return uiUser(db, row.user);
  let username: string | undefined;
  try {
    username = (JSON.parse(row.raw_json) as { username?: string }).username;
  } catch {
    // malformed raw_json — fall through to the generic bot identity
  }
  if (!username) return uiUser(db, null, row.bot_id);
  const seed = row.bot_id ?? username;
  return {
    id: seed,
    name: username.toLowerCase().replace(/\s+/g, ""),
    realName: username,
    initials: initialsOf(username),
    color: tintFor(seed),
    isBot: true,
  };
}

export interface UiReaction {
  name: string;
  count: number;
  reactedBySelf: boolean;
  users: string[];
}

export interface UiFile {
  id: string;
  name: string;
  title: string;
  filetype: string;
  size: number;
}

export interface UiMessage {
  ts: string;
  timeMs: number;
  author: UiUser;
  text: string;
  /** Block Kit payload, when the message was posted with one. */
  blocks: unknown[] | null;
  edited: boolean;
  reactions: UiReaction[];
  files: UiFile[];
  pinned: boolean;
  isSandboxCreated: boolean;
  /** Thread teaser (roots only). */
  replyCount: number;
  replyUsers: UiUser[];
  latestReplyMs: number | null;
  /** True when this message continues the previous author's group. */
  continuation: boolean;
  /** Day divider label to render ABOVE this message, if any. */
  dayDivider: string | null;
}

export interface UiChannelSummary {
  id: string;
  name: string;
  kind: "channel" | "private" | "im" | "mpim";
  isMember: boolean;
  isArchived: boolean;
  isGeneral: boolean;
  /** For DMs: the counterpart user. */
  partner: UiUser | null;
  memberCount: number;
  lastMessageMs: number | null;
  /** Unread messages since the read cursor (drives the bold row). */
  unread: number;
  /** Badge number: mentions in channels, all unread in DMs. */
  badge: number;
}

function conversationKind(c: ConversationRow): UiChannelSummary["kind"] {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  if (c.is_private) return "private";
  return "channel";
}

function dmPartner(db: Database, c: ConversationRow, selfId: string): UiUser | null {
  if (!c.is_im && !c.is_mpim) return null;
  const members = listMembers(db, c.id, null, 20).filter((m) => m !== selfId);
  return members.length ? uiUser(db, members[0]) : null;
}

function lastMessageMs(db: Database, channelId: string): number | null {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM messages WHERE channel_id = ?")
    .get(channelId) as { ts: string | null };
  return row.ts ? tsToMs(row.ts) : null;
}

/** Sidebar: channels + DMs the self user can see. */
export function sidebarView(db: Database) {
  const self = getSelf(db);
  const rows = listConversations(db, {
    types: ["public_channel", "private_channel", "mpim", "im"],
    excludeArchived: false,
    afterId: null,
    limit: 500,
  }).filter((c) => !c.is_private || isMember(db, c.id, self.userId));

  const channels: UiChannelSummary[] = [];
  const dms: UiChannelSummary[] = [];
  for (const c of rows) {
    const partner = dmPartner(db, c, self.userId);
    const isDm = !!c.is_im || !!c.is_mpim;
    // Only members have read state; non-members see no unread affordance.
    const counts = isMember(db, c.id, self.userId)
      ? unreadCounts(db, c.id, self.userId, { isDm })
      : { unread: 0, display: 0, mentions: 0, lastRead: "0" };
    const summary: UiChannelSummary = {
      id: c.id,
      name: c.is_im
        ? partner?.realName ?? c.id
        : c.is_mpim
          ? listMembers(db, c.id, null, 20)
              .filter((m) => m !== self.userId)
              .map((m) => uiUser(db, m).name)
              .join(", ")
          : c.name ?? c.id,
      kind: conversationKind(c),
      isMember: isMember(db, c.id, self.userId),
      isArchived: !!c.is_archived,
      isGeneral: !!c.is_general,
      partner,
      memberCount: c.num_members,
      lastMessageMs: lastMessageMs(db, c.id),
      unread: counts.unread,
      badge: counts.display,
    };
    if (c.is_im || c.is_mpim) dms.push(summary);
    else channels.push(summary);
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => (b.lastMessageMs ?? 0) - (a.lastMessageMs ?? 0));

  return {
    self: uiUser(db, self.userId),
    team: { name: self.teamName, domain: self.teamDomain },
    channels,
    dms,
  };
}

const DAY_MS = 86_400_000;

function dayLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const startOf = (x: number) => {
    const dd = new Date(x);
    return Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate());
  };
  const diff = (startOf(nowMs) - startOf(ms)) / DAY_MS;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const GROUP_WINDOW_MS = 5 * 60_000;

/** Decorate a chronological run of rows with grouping + day dividers. */
function decorate(db: Database, rows: MessageRow[], selfId: string, nowMs: number): UiMessage[] {
  const out: UiMessage[] = [];
  let prev: { authorId: string; ms: number; day: number } | null = null;
  for (const r of rows) {
    const author = uiAuthor(db, r);
    const ms = tsToMs(r.ts);
    const day = Math.floor(ms / DAY_MS);
    const reactions = getReactionsFor(db, r.channel_id, r.ts).map((x) => ({
      name: x.name,
      count: x.count,
      users: x.users,
      reactedBySelf: x.users.includes(selfId),
    }));
    const files = r.has_files
      ? getFilesForMessage(db, r.channel_id, r.ts).map((f) => ({
          id: f.id,
          name: f.name ?? "file",
          title: f.title ?? f.name ?? "file",
          filetype: f.filetype ?? "",
          size: f.size,
        }))
      : [];
    const isRoot = !r.thread_ts || r.thread_ts === r.ts;
    const newDay = !prev || prev.day !== day;
    out.push({
      ts: r.ts,
      timeMs: ms,
      author,
      text: r.text ?? "",
      blocks: r.blocks_json ? (JSON.parse(r.blocks_json) as unknown[]) : null,
      edited: !!r.edited_ts,
      reactions,
      files,
      pinned: isPinned(db, r.channel_id, r.ts),
      isSandboxCreated: !!r.is_sandbox_created,
      replyCount: isRoot ? r.reply_count : 0,
      replyUsers:
        isRoot && r.reply_count > 0
          ? (
              db
                .prepare(
                  `SELECT DISTINCT user FROM messages
                   WHERE channel_id = ? AND thread_ts = ? AND ts != ? AND user IS NOT NULL
                   ORDER BY ts LIMIT 5`,
                )
                .all(r.channel_id, r.ts, r.ts) as Array<{ user: string }>
            ).map((u) => uiUser(db, u.user))
          : [],
      latestReplyMs: isRoot && r.latest_reply ? tsToMs(r.latest_reply) : null,
      // Group consecutive messages from one author within 5 minutes, but never
      // across a day divider.
      continuation:
        !newDay &&
        !!prev &&
        prev.authorId === author.id &&
        ms - prev.ms < GROUP_WINDOW_MS,
      dayDivider: newDay ? dayLabel(ms, nowMs) : null,
    });
    prev = { authorId: author.id, ms, day };
  }
  return out;
}

export function channelView(
  db: Database,
  channelId: string,
  nowMs = Date.now(),
  opts: { markRead?: boolean } = {},
) {
  const self = getSelf(db);
  const conv = getConversation(db, channelId);
  if (!conv || (conv.is_private && !isMember(db, conv.id, self.userId))) return null;
  // Oldest-first for display.
  const rows = getHistory(db, channelId, { limit: 200 }).reverse();
  const partner = dmPartner(db, conv, self.userId);
  // Opening a channel clears its badge, the same as clicking into it in Slack.
  // The poll passes markRead=false so a background refresh can't silently
  // clear unreads for a channel you are not looking at.
  if (opts.markRead && isMember(db, conv.id, self.userId)) {
    markAllRead(db, conv.id, self.userId);
  }
  return {
    channel: {
      id: conv.id,
      name: conv.is_im ? partner?.realName ?? conv.id : conv.name ?? conv.id,
      kind: conversationKind(conv),
      topic: conv.topic_json ? (JSON.parse(conv.topic_json) as { value: string }).value : "",
      purpose: conv.purpose_json ? (JSON.parse(conv.purpose_json) as { value: string }).value : "",
      memberCount: conv.num_members,
      isArchived: !!conv.is_archived,
      partner,
    },
    messages: decorate(db, rows, self.userId, nowMs),
  };
}

export function threadView(db: Database, channelId: string, ts: string, nowMs = Date.now()) {
  const self = getSelf(db);
  const conv = getConversation(db, channelId);
  if (!conv || (conv.is_private && !isMember(db, conv.id, self.userId))) return null;
  if (!getMessage(db, channelId, ts)) return null;
  const rows = getReplies(db, channelId, ts, { limit: 500 });
  const decorated = decorate(db, rows, self.userId, nowMs);
  // The parent always renders as a full (non-continuation) message.
  if (decorated[0]) decorated[0] = { ...decorated[0], continuation: false, dayDivider: null };
  return {
    channel: { id: conv.id, name: conv.name ?? conv.id, kind: conversationKind(conv) },
    parent: decorated[0] ?? null,
    replies: decorated.slice(1),
  };
}

/** Directory of users for @mention rendering. */
export function userDirectory(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of listUsers(db, null, 1000)) {
    const shaped = shapeUser(u);
    out[u.id] = shaped.name ?? u.id;
  }
  return out;
}

/** Directory of conversations for #channel rendering. */
export function channelDirectory(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = listConversations(db, {
    types: ["public_channel", "private_channel"],
    excludeArchived: false,
    afterId: null,
    limit: 500,
  });
  for (const c of rows) out[c.id] = c.name ?? c.id;
  return out;
}
