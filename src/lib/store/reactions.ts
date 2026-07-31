import type { Database } from "better-sqlite3";
import type { SlackReaction } from "../slack/types";

// Reactions live in their own table (raw_json never contains them); reads
// hydrate them onto the message via getReactionsFor. Order: first-reacted
// first, users in reaction order — we approximate with rowid order.

/** @returns false if the (message, name, user) reaction already exists. */
export function addReaction(
  db: Database,
  channelId: string,
  messageTs: string,
  name: string,
  userId: string,
): boolean {
  const res = db
    .prepare(
      "INSERT OR IGNORE INTO reactions (channel_id, message_ts, name, user_id) VALUES (?, ?, ?, ?)",
    )
    .run(channelId, messageTs, name, userId);
  return res.changes > 0;
}

/** @returns false if no such reaction existed. */
export function removeReaction(
  db: Database,
  channelId: string,
  messageTs: string,
  name: string,
  userId: string,
): boolean {
  const res = db
    .prepare(
      "DELETE FROM reactions WHERE channel_id = ? AND message_ts = ? AND name = ? AND user_id = ?",
    )
    .run(channelId, messageTs, name, userId);
  return res.changes > 0;
}

/** Grouped reactions for a message, in Slack's `reactions[]` shape. */
export function getReactionsFor(
  db: Database,
  channelId: string,
  messageTs: string,
): SlackReaction[] {
  const rows = db
    .prepare(
      "SELECT name, user_id FROM reactions WHERE channel_id = ? AND message_ts = ? ORDER BY rowid",
    )
    .all(channelId, messageTs) as Array<{ name: string; user_id: string }>;
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const users = byName.get(r.name);
    if (users) users.push(r.user_id);
    else byName.set(r.name, [r.user_id]);
  }
  return [...byName.entries()].map(([name, users]) => ({ name, users, count: users.length }));
}

/** Messages a user has reacted to (reactions.list), newest message first. */
export function listReactedMessages(
  db: Database,
  userId: string,
  limit: number,
): Array<{ channel_id: string; message_ts: string }> {
  return db
    .prepare(
      `SELECT DISTINCT channel_id, message_ts FROM reactions
       WHERE user_id = ? ORDER BY message_ts DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{ channel_id: string; message_ts: string }>;
}
