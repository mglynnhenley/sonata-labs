import type { Database } from "better-sqlite3";

export interface PinRow {
  channel_id: string;
  message_ts: string;
  created_by: string | null;
  created: number;
}

/** @returns false if the message was already pinned. */
export function addPin(
  db: Database,
  channelId: string,
  messageTs: string,
  createdBy: string,
  created: number,
): boolean {
  const res = db
    .prepare(
      "INSERT OR IGNORE INTO pins (channel_id, message_ts, created_by, created) VALUES (?, ?, ?, ?)",
    )
    .run(channelId, messageTs, createdBy, created);
  return res.changes > 0;
}

/** @returns false if the message was not pinned. */
export function removePin(db: Database, channelId: string, messageTs: string): boolean {
  const res = db
    .prepare("DELETE FROM pins WHERE channel_id = ? AND message_ts = ?")
    .run(channelId, messageTs);
  return res.changes > 0;
}

export function listPins(db: Database, channelId: string): PinRow[] {
  return db
    .prepare("SELECT * FROM pins WHERE channel_id = ? ORDER BY created DESC")
    .all(channelId) as PinRow[];
}

export function isPinned(db: Database, channelId: string, messageTs: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM pins WHERE channel_id = ? AND message_ts = ?")
    .get(channelId, messageTs);
}
