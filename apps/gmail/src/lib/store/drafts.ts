import type { Database } from "better-sqlite3";

export interface DraftRow {
  id: string;
  message_id: string;
}

export function getDraftRow(db: Database, id: string): DraftRow | null {
  return (db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow) ?? null;
}

export function getDraftByMessage(db: Database, messageId: string): DraftRow | null {
  return (
    (db.prepare("SELECT * FROM drafts WHERE message_id = ?").get(messageId) as DraftRow) ?? null
  );
}

export function listDraftRows(db: Database, limit: number, offset: number): DraftRow[] {
  return db
    .prepare(
      `SELECT d.* FROM drafts d
       JOIN messages m ON m.id = d.message_id
       ORDER BY m.internal_date DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as DraftRow[];
}

export function countDrafts(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n;
}

export function insertDraft(db: Database, id: string, messageId: string): void {
  db.prepare("INSERT INTO drafts (id, message_id) VALUES (?, ?)").run(id, messageId);
}

/** drafts.update assigns a NEW message id; repoint the draft to it. */
export function repointDraft(db: Database, draftId: string, newMessageId: string): void {
  db.prepare("UPDATE drafts SET message_id = ? WHERE id = ?").run(newMessageId, draftId);
}

export function deleteDraftRow(db: Database, id: string): void {
  db.prepare("DELETE FROM drafts WHERE id = ?").run(id);
}
