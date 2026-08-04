import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { isMember, listMembers } from "../store/conversations";
import { countMessages } from "../store/messages";
import { getReactionsFor } from "../store/reactions";
import { unreadCounts } from "../store/read-state";
import { getSelf } from "../store/meta";
import type { ConversationRow, MessageRow } from "../slack/types";
import type { SlackTwinSnapshot } from "./types";

// The workspace as the judge sees it. Two of these ship inside every run
// artifact and are diffed to turn "the agent called chat.postMessage" into "the
// team was told about the outage" — so this is a digest, not a dump: counts and
// truncated text, capped per channel and overall.
//
// Scope is what the OWNER can see: public channels plus private conversations
// they belong to. A snapshot that could see more than the agent could would
// score the agent against a world it never had access to.

/** Enough of a channel to see a day's traffic; a workspace history is unbounded. */
const MAX_MESSAGES_PER_CHANNEL = 40;

/** Overall cap, so a 30-channel clone cannot blow up the artifact. */
const MAX_MESSAGES = 300;

/** Text is a digest — long enough to identify a message, short enough to ship. */
const TEXT_CAP = 240;

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function visibleConversations(db: Database, selfId: string): ConversationRow[] {
  const rows = db
    .prepare("SELECT * FROM conversations ORDER BY id")
    .all() as ConversationRow[];
  return rows.filter((c) => !c.is_private || isMember(db, c.id, selfId));
}

function channelLabel(row: ConversationRow, db: Database, selfId: string): string {
  if (row.name) return row.name;
  // DMs have no name; label them by the counterpart, which is how the agent
  // refers to them ("the DM with priya").
  const other = listMembers(db, row.id, null, 10).find((u) => u !== selfId);
  return other ? `dm:${other}` : row.id;
}

function topicOf(row: ConversationRow): string {
  if (!row.topic_json) return "";
  return (JSON.parse(row.topic_json) as { value?: string }).value ?? "";
}

function recentMessages(db: Database, channelId: string): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY ts DESC LIMIT ?")
    .all(channelId, MAX_MESSAGES_PER_CHANNEL) as MessageRow[];
}

export function captureTwinSnapshot(db: Database): SlackTwinSnapshot {
  const selfId = getSelf(db).userId;
  const conversations = visibleConversations(db, selfId);

  const channels: SlackTwinSnapshot["channels"] = [];
  const messages: SlackTwinSnapshot["messages"] = [];

  for (const c of conversations) {
    const name = channelLabel(c, db, selfId);
    const counts = unreadCounts(db, c.id, selfId, { isDm: !!c.is_im || !!c.is_mpim });
    channels.push({
      id: c.id,
      name,
      topic: topicOf(c),
      isPrivate: !!c.is_private,
      isArchived: !!c.is_archived,
      memberCount: c.num_members,
      messageCount: countMessages(db, c.id),
      lastRead: counts.lastRead,
      unread: counts.unread,
    });

    if (messages.length >= MAX_MESSAGES) continue;
    for (const m of recentMessages(db, c.id)) {
      if (messages.length >= MAX_MESSAGES) break;
      const text = m.text ?? "";
      messages.push({
        channelId: c.id,
        channelName: name,
        ts: m.ts,
        // Bot messages carry no user; the bot id is who the reader sees.
        user: m.user ?? m.bot_id ?? "",
        text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text,
        textHash: shortHash(text),
        threadTs: m.thread_ts ?? undefined,
        replyCount: m.reply_count,
        reactions: getReactionsFor(db, c.id, m.ts).map((r) => `${r.name}:${r.count}`),
      });
    }
  }

  return { twin: "slack", capturedAt: Date.now(), channels, messages };
}
