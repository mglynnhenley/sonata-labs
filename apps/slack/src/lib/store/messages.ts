import type { Database } from "better-sqlite3";
import type { MessageRow } from "../slack/types";

// Message storage. Identity is (channel_id, ts); thread replies carry the
// parent's ts in thread_ts (the root's thread_ts equals its own ts). Parent
// thread stats (reply_count / reply_users_count / latest_reply) are recomputed
// from the replies on every change — one less invariant to drift under
// edits/deletes. Every insert/update/delete keeps messages_fts in step.

export interface InsertMessageInput {
  channelId: string;
  ts: string;
  threadTs?: string | null;
  user?: string | null;
  botId?: string | null;
  subtype?: string | null;
  text?: string | null;
  editedTs?: string | null;
  editedUser?: string | null;
  hasFiles?: boolean;
  blocksJson?: string | null;
  rawJson: string;
  isSandboxCreated?: boolean;
}

export function insertMessage(db: Database, m: InsertMessageInput): void {
  db.prepare(
    `INSERT INTO messages
       (channel_id, ts, thread_ts, user, bot_id, subtype, text, edited_ts, edited_user,
        reply_count, reply_users_count, latest_reply, has_files, blocks_json, raw_json, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?)`,
  ).run(
    m.channelId,
    m.ts,
    m.threadTs ?? null,
    m.user ?? null,
    m.botId ?? null,
    m.subtype ?? null,
    m.text ?? null,
    m.editedTs ?? null,
    m.editedUser ?? null,
    m.hasFiles ? 1 : 0,
    m.blocksJson ?? null,
    m.rawJson,
    m.isSandboxCreated ? 1 : 0,
  );
  db.prepare(
    "INSERT INTO messages_fts (channel_id, ts, user, text) VALUES (?, ?, ?, ?)",
  ).run(m.channelId, m.ts, m.user ?? "", m.text ?? "");
  if (m.threadTs && m.threadTs !== m.ts) {
    refreshThreadStats(db, m.channelId, m.threadTs);
  }
}

export function getMessage(db: Database, channelId: string, ts: string): MessageRow | undefined {
  return db
    .prepare("SELECT * FROM messages WHERE channel_id = ? AND ts = ?")
    .get(channelId, ts) as MessageRow | undefined;
}

export interface HistoryOpts {
  oldest?: string | null; // ts, exclusive unless inclusive
  latest?: string | null; // ts, exclusive unless inclusive
  inclusive?: boolean;
  limit: number;
}

/**
 * conversations.history semantics: newest-first, thread REPLIES EXCLUDED
 * (roots appear with their reply stats; replies come from getReplies). ts
 * strings compare lexically == numerically (fixed-width seconds + micros).
 */
export function getHistory(db: Database, channelId: string, opts: HistoryOpts): MessageRow[] {
  const clauses = ["channel_id = ?", "(thread_ts IS NULL OR thread_ts = ts)"];
  const params: unknown[] = [channelId];
  const lt = opts.inclusive ? "<=" : "<";
  const gt = opts.inclusive ? ">=" : ">";
  if (opts.latest) {
    clauses.push(`ts ${lt} ?`);
    params.push(opts.latest);
  }
  if (opts.oldest) {
    clauses.push(`ts ${gt} ?`);
    params.push(opts.oldest);
  }
  params.push(opts.limit);
  return db
    .prepare(
      `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
    )
    .all(...params) as MessageRow[];
}

/** conversations.replies: the parent first, then replies oldest-first. */
export function getReplies(
  db: Database,
  channelId: string,
  threadTs: string,
  opts: { oldest?: string | null; latest?: string | null; inclusive?: boolean; limit: number },
): MessageRow[] {
  const parent = getMessage(db, channelId, threadTs);
  if (!parent) return [];
  const clauses = ["channel_id = ?", "thread_ts = ?", "ts != ?"];
  const params: unknown[] = [channelId, threadTs, threadTs];
  const lt = opts.inclusive ? "<=" : "<";
  const gt = opts.inclusive ? ">=" : ">";
  if (opts.latest) {
    clauses.push(`ts ${lt} ?`);
    params.push(opts.latest);
  }
  if (opts.oldest) {
    clauses.push(`ts ${gt} ?`);
    params.push(opts.oldest);
  }
  params.push(opts.limit);
  const replies = db
    .prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY ts ASC LIMIT ?`)
    .all(...params) as MessageRow[];
  return [parent, ...replies];
}

export function updateMessageText(
  db: Database,
  channelId: string,
  ts: string,
  text: string,
  editedUser: string,
  editedTs: string,
  blocksJson?: string | null,
): void {
  db.prepare(
    `UPDATE messages SET text = ?, edited_ts = ?, edited_user = ?, blocks_json = COALESCE(?, blocks_json)
     WHERE channel_id = ? AND ts = ?`,
  ).run(text, editedTs, editedUser, blocksJson ?? null, channelId, ts);
  db.prepare("DELETE FROM messages_fts WHERE channel_id = ? AND ts = ?").run(channelId, ts);
  const row = getMessage(db, channelId, ts);
  db.prepare(
    "INSERT INTO messages_fts (channel_id, ts, user, text) VALUES (?, ?, ?, ?)",
  ).run(channelId, ts, row?.user ?? "", text);
}

/** Delete a message plus its FTS row, reactions, pins, and file links. */
export function deleteMessage(db: Database, channelId: string, ts: string): void {
  const row = getMessage(db, channelId, ts);
  db.prepare("DELETE FROM messages WHERE channel_id = ? AND ts = ?").run(channelId, ts);
  db.prepare("DELETE FROM messages_fts WHERE channel_id = ? AND ts = ?").run(channelId, ts);
  db.prepare("DELETE FROM reactions WHERE channel_id = ? AND message_ts = ?").run(channelId, ts);
  db.prepare("DELETE FROM pins WHERE channel_id = ? AND message_ts = ?").run(channelId, ts);
  db.prepare("DELETE FROM message_files WHERE channel_id = ? AND message_ts = ?").run(
    channelId,
    ts,
  );
  if (row?.thread_ts && row.thread_ts !== ts) {
    refreshThreadStats(db, channelId, row.thread_ts);
  }
}

/** Recompute a thread root's reply stats from its replies. */
export function refreshThreadStats(db: Database, channelId: string, threadTs: string): void {
  db.prepare(
    `UPDATE messages SET
       reply_count = (SELECT COUNT(*) FROM messages r
                      WHERE r.channel_id = @ch AND r.thread_ts = @ts AND r.ts != @ts),
       reply_users_count = (SELECT COUNT(DISTINCT r.user) FROM messages r
                            WHERE r.channel_id = @ch AND r.thread_ts = @ts AND r.ts != @ts),
       latest_reply = (SELECT MAX(r.ts) FROM messages r
                       WHERE r.channel_id = @ch AND r.thread_ts = @ts AND r.ts != @ts),
       thread_ts = @ts
     WHERE channel_id = @ch AND ts = @ts`,
  ).run({ ch: channelId, ts: threadTs });
}

export function countMessages(db: Database, channelId?: string): number {
  if (channelId) {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(channelId) as {
        n: number;
      }
    ).n;
  }
  return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
}
