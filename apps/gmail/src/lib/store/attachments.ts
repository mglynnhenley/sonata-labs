import type { Database } from "better-sqlite3";
import { b64urlEncode } from "../gmail/base64";

export interface AttachmentRow {
  message_id: string;
  attachment_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number;
  data: Buffer | null;
}

export function insertAttachment(
  db: Database,
  a: {
    messageId: string;
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
    data: Buffer | null;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO attachments (message_id, attachment_id, filename, mime_type, size, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(a.messageId, a.attachmentId, a.filename, a.mimeType, a.size, a.data);
}

/**
 * Gmail attachments.get body: { attachmentId, size, data }. Returns null when
 * the attachment doesn't exist OR its data is over the sync cap (metadata-only)
 * — the route turns null into a Gmail-shaped 404.
 */
export function getAttachmentBody(
  db: Database,
  messageId: string,
  attachmentId: string,
): { attachmentId: string; size: number; data: string } | null {
  const row = db
    .prepare(
      "SELECT * FROM attachments WHERE message_id = ? AND attachment_id = ?",
    )
    .get(messageId, attachmentId) as AttachmentRow | undefined;
  if (!row || row.data == null) return null;
  return {
    attachmentId,
    size: row.size,
    data: b64urlEncode(row.data),
  };
}
