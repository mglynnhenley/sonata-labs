import type { Database } from "better-sqlite3";
import type { GmailThread } from "../gmail/types";
import { buildMessageWhere, getMessageRow, getLabelIds, type ListFilter } from "./messages";
import { shapeMessage } from "../gmail/shape";
import type { MessageFormat } from "../gmail/types";

// No threads table — a thread is a GROUP BY over messages. A thread matches a
// filter if at least one of its messages matches (Gmail's behavior for
// threads.list).

export interface ThreadListItem {
  id: string;
  snippet: string;
  historyId: string;
}

export interface ThreadListResult {
  threads: ThreadListItem[];
  total: number;
  hasMore: boolean;
}

export function listThreads(db: Database, filter: ListFilter): ThreadListResult {
  const { sql, params } = buildMessageWhere(filter);

  // Distinct threads whose members match, plus the latest message's snippet.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.thread_id FROM messages m WHERE ${sql})`,
    )
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT m.thread_id AS id,
              MAX(m.internal_date) AS latest,
              MAX(m.history_id) AS historyId
       FROM messages m
       WHERE ${sql}
       GROUP BY m.thread_id
       ORDER BY latest DESC, m.thread_id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as Array<{
    id: string;
    latest: number;
    historyId: number;
  }>;

  const snippetStmt = db.prepare(
    `SELECT snippet FROM messages WHERE thread_id = ? ORDER BY internal_date DESC LIMIT 1`,
  );

  const threads = rows.map((r) => ({
    id: r.id,
    snippet: (snippetStmt.get(r.id) as { snippet: string } | undefined)?.snippet ?? "",
    historyId: String(r.historyId),
  }));

  return {
    threads,
    total: totalRow.n,
    hasMore: filter.offset + rows.length < totalRow.n,
  };
}

export function threadExists(db: Database, threadId: string): boolean {
  return !!db.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId);
}

/** Full thread resource: id, historyId, and all messages ascending by date. */
export function getThread(
  db: Database,
  threadId: string,
  format: MessageFormat = "full",
): GmailThread | null {
  const ids = (
    db
      .prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY internal_date ASC, id ASC")
      .all(threadId) as { id: string }[]
  ).map((r) => r.id);

  if (ids.length === 0) return null;

  let maxHistory = 0;
  const messages = ids.map((id) => {
    const row = getMessageRow(db, id)!;
    if (row.history_id > maxHistory) maxHistory = row.history_id;
    return shapeMessage(row, getLabelIds(db, id), format === "raw" ? "full" : format);
  });

  return { id: threadId, historyId: String(maxHistory), messages };
}
