import type { Database } from "better-sqlite3";
import type { MessageRow, SlackMessage } from "./types";
import { getReactionsFor } from "../store/reactions";
import { getFilesForMessage, shapeFile } from "../store/files";
import { isPinned } from "../store/pins";

// The fidelity linchpin. raw_json holds a message resource WITHOUT reactions,
// thread stats, edits, or pin state — those live in their own tables and are
// the live source of truth. Every read overlays them, so mutations are always
// visible and the resource stays byte-faithful to what Slack would serve.

/** Distinct reply authors for a thread root (Slack caps reply_users at 5). */
function replyUsers(db: Database, channelId: string, threadTs: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT user FROM messages
       WHERE channel_id = ? AND thread_ts = ? AND ts != ? AND user IS NOT NULL
       ORDER BY ts LIMIT 5`,
    )
    .all(channelId, threadTs, threadTs) as Array<{ user: string }>;
  return rows.map((r) => r.user);
}

export function shapeMessage(db: Database, row: MessageRow): SlackMessage {
  const base = JSON.parse(row.raw_json) as SlackMessage;
  const out: SlackMessage = {
    ...base,
    type: "message",
    ts: row.ts,
    text: row.text ?? base.text,
  };
  if (row.user) out.user = row.user;
  if (row.bot_id) out.bot_id = row.bot_id;
  if (row.subtype) out.subtype = row.subtype;
  if (row.blocks_json) out.blocks = JSON.parse(row.blocks_json) as unknown[];

  // Thread overlay. A root with zero replies carries no thread fields at all
  // (deleting the last reply un-threads it, matching Slack).
  if (row.thread_ts && row.thread_ts !== row.ts) {
    out.thread_ts = row.thread_ts; // reply
  } else if (row.thread_ts === row.ts && row.reply_count > 0) {
    out.thread_ts = row.ts;
    out.reply_count = row.reply_count;
    out.reply_users_count = row.reply_users_count;
    if (row.latest_reply) out.latest_reply = row.latest_reply;
    out.reply_users = replyUsers(db, row.channel_id, row.ts);
  }

  if (row.edited_ts) {
    out.edited = { user: row.edited_user ?? undefined, ts: row.edited_ts };
  }

  const reactions = getReactionsFor(db, row.channel_id, row.ts);
  if (reactions.length) out.reactions = reactions;

  if (row.has_files) {
    const files = getFilesForMessage(db, row.channel_id, row.ts);
    if (files.length) out.files = files.map((f) => shapeFile(db, f));
  }

  if (isPinned(db, row.channel_id, row.ts)) out.pinned_to = [row.channel_id];

  return out;
}
