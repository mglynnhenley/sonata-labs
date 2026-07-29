import type { Database } from "better-sqlite3";
import { newHexId } from "../gmail/ids";

export interface OutboxRow {
  id: string;
  message_id: string;
  envelope_to: string | null;
  raw_rfc822: string | null;
  created_at: number;
}

export function insertOutbox(
  db: Database,
  o: { messageId: string; envelopeTo: string[]; rawRfc822: string; createdAt: number },
): string {
  const id = newHexId();
  db.prepare(
    "INSERT INTO outbox (id, message_id, envelope_to, raw_rfc822, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, o.messageId, JSON.stringify(o.envelopeTo), o.rawRfc822, o.createdAt);
  return id;
}

export interface OutboxItem {
  id: string;
  messageId: string;
  envelopeTo: string[];
  createdAt: number;
}

export function listOutbox(db: Database): OutboxItem[] {
  const rows = db
    .prepare("SELECT id, message_id, envelope_to, created_at FROM outbox ORDER BY created_at DESC")
    .all() as Array<Omit<OutboxRow, "raw_rfc822">>;
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    envelopeTo: r.envelope_to ? JSON.parse(r.envelope_to) : [],
    createdAt: r.created_at,
  }));
}
