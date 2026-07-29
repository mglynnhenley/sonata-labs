import type { Database } from "better-sqlite3";
import type { MessageRow } from "../gmail/types";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getMessageRow(db: Database, id: string): MessageRow | null {
  return (db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow) ?? null;
}

export function messageExists(db: Database, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
}

/** Live labelIds for a message, from the join table. */
export function getLabelIds(db: Database, messageId: string): string[] {
  return (
    db
      .prepare("SELECT label_id FROM message_labels WHERE message_id = ? ORDER BY label_id")
      .all(messageId) as { label_id: string }[]
  ).map((r) => r.label_id);
}

/** Batch variant: map of messageId → labelIds (avoids N queries in lists). */
export function getLabelIdsForMany(db: Database, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const id of ids) map.set(id, []);
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT message_id, label_id FROM message_labels WHERE message_id IN (${placeholders}) ORDER BY label_id`,
    )
    .all(...ids) as { message_id: string; label_id: string }[];
  for (const r of rows) map.get(r.message_id)?.push(r.label_id);
  return map;
}

// ---------------------------------------------------------------------------
// Listing (shared by messages.list and, via `search`, the UI).
// ---------------------------------------------------------------------------

export interface SearchClause {
  sql: string; // a boolean SQL expression over alias `m`
  params: unknown[];
  disableTrashExclusion?: boolean; // e.g. `in:trash`
}

export interface ListFilter {
  labelIds?: string[];
  includeSpamTrash?: boolean;
  search?: SearchClause | null;
  offset: number;
  limit: number;
}

export interface ListResult {
  ids: Array<{ id: string; threadId: string }>;
  total: number;
  hasMore: boolean;
}

export function buildMessageWhere(filter: ListFilter): { sql: string; params: unknown[] } {
  return buildWhere(filter);
}

function buildWhere(filter: ListFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const labelId of filter.labelIds ?? []) {
    clauses.push(
      "EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)",
    );
    params.push(labelId);
  }

  if (filter.search) {
    clauses.push(`(${filter.search.sql})`);
    params.push(...filter.search.params);
  }

  const excludeTrash = !filter.includeSpamTrash && !filter.search?.disableTrashExclusion;
  if (excludeTrash) {
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM message_labels t WHERE t.message_id = m.id AND t.label_id IN ('TRASH','SPAM'))",
    );
  }

  const sql = clauses.length ? clauses.join(" AND ") : "1=1";
  return { sql, params };
}

export function listMessages(db: Database, filter: ListFilter): ListResult {
  const { sql, params } = buildWhere(filter);

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${sql}`).get(...params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT m.id AS id, m.thread_id AS threadId FROM messages m
       WHERE ${sql}
       ORDER BY m.internal_date DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as Array<{ id: string; threadId: string }>;

  return {
    ids: rows,
    total,
    hasMore: filter.offset + rows.length < total,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface InsertMessageInput {
  id: string;
  threadId: string;
  internalDate: number;
  historyId: number;
  sizeEstimate: number;
  snippet: string;
  subject?: string | null;
  fromAddr?: string | null;
  toAddrs?: string | null;
  ccAddrs?: string | null;
  bccAddrs?: string | null;
  rfc822MessageId?: string | null;
  inReplyTo?: string | null;
  hasAttachment?: boolean;
  bodyText?: string | null;
  rawJson: string;
  rawRfc822?: string | null;
  isSandboxCreated?: boolean;
  labelIds: string[];
}

export function insertMessage(db: Database, input: InsertMessageInput): void {
  db.prepare(
    `INSERT INTO messages (
       id, thread_id, internal_date, history_id, size_estimate, snippet,
       subject, from_addr, to_addrs, cc_addrs, bcc_addrs,
       rfc822_message_id, in_reply_to, has_attachment, body_text,
       raw_json, raw_rfc822, is_sandbox_created
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.threadId,
    input.internalDate,
    input.historyId,
    input.sizeEstimate,
    input.snippet,
    input.subject ?? null,
    input.fromAddr ?? null,
    input.toAddrs ?? null,
    input.ccAddrs ?? null,
    input.bccAddrs ?? null,
    input.rfc822MessageId ?? null,
    input.inReplyTo ?? null,
    input.hasAttachment ? 1 : 0,
    input.bodyText ?? null,
    input.rawJson,
    input.rawRfc822 ?? null,
    input.isSandboxCreated ? 1 : 0,
  );

  const insLabel = db.prepare(
    "INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)",
  );
  for (const labelId of input.labelIds) insLabel.run(input.id, labelId);

  upsertFts(db, {
    messageId: input.id,
    subject: input.subject ?? "",
    fromAddr: input.fromAddr ?? "",
    toAddrs: input.toAddrs ?? "",
    body: input.bodyText ?? "",
  });
}

export function upsertFts(
  db: Database,
  row: { messageId: string; subject: string; fromAddr: string; toAddrs: string; body: string },
): void {
  db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(row.messageId);
  db.prepare(
    "INSERT INTO messages_fts (message_id, subject, from_addr, to_addrs, body) VALUES (?, ?, ?, ?, ?)",
  ).run(row.messageId, row.subject, row.fromAddr, row.toAddrs, row.body);
}

export function setHistoryId(db: Database, messageId: string, historyId: number): void {
  db.prepare("UPDATE messages SET history_id = ? WHERE id = ?").run(historyId, messageId);
}

/**
 * Bump the global history counter once and stamp it on the given messages.
 * Call inside a mutation transaction. Returns the new historyId.
 */
export function bumpMessageHistory(db: Database, messageIds: string[]): number {
  // Local import avoids a cycle at module top-level.
  const hid = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'history_counter'").get() as
      | { value: string }
      | undefined)?.value ?? "0",
  ) + 1;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('history_counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(hid));
  const stmt = db.prepare("UPDATE messages SET history_id = ? WHERE id = ?");
  for (const id of messageIds) stmt.run(hid, id);
  return hid;
}

// Label mutation primitives. Callers wrap these in a transaction with a history
// bump + audit row.
export function addLabels(db: Database, messageId: string, labelIds: string[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)",
  );
  for (const l of labelIds) stmt.run(messageId, l);
}

export function removeLabels(db: Database, messageId: string, labelIds: string[]): void {
  if (labelIds.length === 0) return;
  const placeholders = labelIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM message_labels WHERE message_id = ? AND label_id IN (${placeholders})`,
  ).run(messageId, ...labelIds);
}

export function deleteMessage(db: Database, messageId: string): void {
  db.prepare("DELETE FROM message_labels WHERE message_id = ?").run(messageId);
  db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId);
  db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
  db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
}

/** Find the thread of the message whose RFC822 Message-ID matches any candidate. */
export function findThreadByRfc822(db: Database, candidates: string[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const row = db
      .prepare("SELECT thread_id FROM messages WHERE rfc822_message_id = ? LIMIT 1")
      .get(c) as { thread_id: string } | undefined;
    if (row) return row.thread_id;
  }
  return null;
}

export function messageIdsInThread(db: Database, threadId: string): string[] {
  return (
    db
      .prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY internal_date ASC")
      .all(threadId) as { id: string }[]
  ).map((r) => r.id);
}
