import type { Database } from "better-sqlite3";

// Read cursors and the counts derived from them. Slack semantics:
//   - unread_count counts messages NEWER than last_read
//   - your own messages never count as unread
//   - thread replies do not bump the channel badge (they surface in Threads)
//   - unread_count_display is the "badge" number: DMs count every message,
//     channels count only mentions of you (@you, @here, @channel, @everyone)
//
// Nothing is cached: every read recomputes from `messages`, so counts can never
// drift from reality the way a stored counter would.

export const ZERO_TS = "0000000000.000000";

export function getLastRead(db: Database, conversationId: string, userId: string): string {
  const row = db
    .prepare("SELECT last_read FROM read_state WHERE conversation_id = ? AND user_id = ?")
    .get(conversationId, userId) as { last_read: string } | undefined;
  return row?.last_read ?? ZERO_TS;
}

export function setLastRead(
  db: Database,
  conversationId: string,
  userId: string,
  ts: string,
): void {
  db.prepare(
    `INSERT INTO read_state (conversation_id, user_id, last_read) VALUES (?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read = excluded.last_read`,
  ).run(conversationId, userId, ts);
}

/** Mark everything currently in the conversation as read. */
export function markAllRead(db: Database, conversationId: string, userId: string): string {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM messages WHERE channel_id = ?")
    .get(conversationId) as { ts: string | null };
  const ts = row.ts ?? ZERO_TS;
  setLastRead(db, conversationId, userId, ts);
  return ts;
}

export interface UnreadCounts {
  lastRead: string;
  /** Messages newer than last_read, excluding the user's own. */
  unread: number;
  /** Badge count: mentions in channels, all messages in DMs/mpims. */
  display: number;
  mentions: number;
}

/**
 * Mention detection matches Slack's link format `<@U123>` plus the broadcast
 * keywords. Deliberately matches the stored text, which is what agents post.
 */
function mentionClause(): string {
  return `(
    m.text LIKE '%<@' || @user || '>%'
    OR m.text LIKE '%<!here%'
    OR m.text LIKE '%<!channel%'
    OR m.text LIKE '%<!everyone%'
  )`;
}

export function unreadCounts(
  db: Database,
  conversationId: string,
  userId: string,
  opts: { isDm: boolean },
): UnreadCounts {
  const lastRead = getLastRead(db, conversationId, userId);

  // Channel badges ignore thread replies — those live in the Threads view.
  const base = `FROM messages m
    WHERE m.channel_id = @chan
      AND m.ts > @lastRead
      AND (m.user IS NULL OR m.user != @user)
      AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)`;

  const params = { chan: conversationId, user: userId, lastRead };

  const unread = (
    db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params) as { n: number }
  ).n;

  const mentions = (
    db.prepare(`SELECT COUNT(*) AS n ${base} AND ${mentionClause()}`).get(params) as {
      n: number;
    }
  ).n;

  return {
    lastRead,
    unread,
    mentions,
    display: opts.isDm ? unread : mentions,
  };
}

/** Total badge across every conversation the user can see (sidebar summary). */
export function totalMentions(db: Database, userId: string): number {
  const rows = db
    .prepare(
      `SELECT c.id, c.is_im, c.is_mpim FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = ? AND c.is_archived = 0`,
    )
    .all(userId) as Array<{ id: string; is_im: number; is_mpim: number }>;
  let total = 0;
  for (const c of rows) {
    total += unreadCounts(db, c.id, userId, { isDm: !!c.is_im || !!c.is_mpim }).display;
  }
  return total;
}
