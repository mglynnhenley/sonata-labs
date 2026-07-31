import type { Database } from "better-sqlite3";

// Sandbox-created outbound messages. Every chat.postMessage records a row (the
// "nothing left the machine" ledger the activity panel shows); scheduled
// messages carry post_at and no messages row until "delivery" is simulated.

export interface OutboxRow {
  id: string;
  channel_id: string;
  message_ts: string;
  post_at: number | null;
  request_json: string | null;
  created_at: number;
}

export function addOutboxRow(
  db: Database,
  row: {
    id: string;
    channelId: string;
    messageTs: string;
    postAt?: number | null;
    request?: unknown;
    createdAt: number;
  },
): void {
  db.prepare(
    "INSERT INTO outbox (id, channel_id, message_ts, post_at, request_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.channelId,
    row.messageTs,
    row.postAt ?? null,
    row.request != null ? JSON.stringify(row.request) : null,
    row.createdAt,
  );
}

export function deleteOutboxRow(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM outbox WHERE id = ?").run(id).changes > 0;
}

export function getOutboxRow(db: Database, id: string): OutboxRow | undefined {
  return db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
}

export function listOutbox(db: Database, opts?: { scheduledOnly?: boolean; channelId?: string }): OutboxRow[] {
  const clauses: string[] = ["1=1"];
  const params: unknown[] = [];
  if (opts?.scheduledOnly) clauses.push("post_at IS NOT NULL");
  if (opts?.channelId) {
    clauses.push("channel_id = ?");
    params.push(opts.channelId);
  }
  return db
    .prepare(`SELECT * FROM outbox WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(...params) as OutboxRow[];
}
