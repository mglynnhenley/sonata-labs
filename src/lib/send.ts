import type { Database } from "better-sqlite3";
import { parseRfc822, buildPayload, type NormalizedMail } from "./gmail/mime";
import { newMessageId, newAttachmentId } from "./gmail/ids";
import {
  insertMessage,
  getMessageRow,
  getLabelIds,
  findThreadByRfc822,
  bumpMessageHistory,
} from "./store/messages";
import { threadExists } from "./store/threads";
import { insertAttachment } from "./store/attachments";
import { insertOutbox } from "./store/outbox";
import { shapeMessage } from "./gmail/shape";
import type { GmailMessage, GmailPayload } from "./gmail/types";

// Send pipeline (simulated — nothing leaves the machine). Split so the async
// RFC822 parse runs OUTSIDE the DB transaction (better-sqlite3 transactions must
// be synchronous), and commitSend does only synchronous DB work inside it.

function splitAddrs(s?: string): string[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export interface PreparedSend {
  raw: Buffer;
  normalized: NormalizedMail;
  payload: GmailPayload;
  bodyText: string;
  snippet: string;
  hasAttachment: boolean;
}

/** Async: parse raw RFC822, assign attachment ids, build the payload tree. */
export async function prepareSend(raw: Buffer): Promise<PreparedSend> {
  const parsed = await parseRfc822(raw);
  const normalized = parsed.normalized;
  if (normalized.attachments) {
    for (const att of normalized.attachments) att.attachmentId = newAttachmentId();
  }
  const payload = buildPayload(normalized);
  return {
    raw,
    normalized,
    payload,
    bodyText: parsed.bodyText,
    snippet: parsed.snippet,
    hasAttachment: parsed.hasAttachment,
  };
}

export interface SendResult {
  message: GmailMessage;
  messageId: string;
  threadId: string;
}

export interface SendOptions {
  threadId?: string;
  labels?: string[]; // defaults to ['SENT']
}

/** Resolve the thread for a prepared message (explicit → reply-match → new). */
export function resolveThreadId(db: Database, prep: PreparedSend, newId: string, explicit?: string): string {
  if (explicit && threadExists(db, explicit)) return explicit;
  const { normalized } = prep;
  const refs = [
    normalized.inReplyTo ?? "",
    ...(normalized.references ? normalized.references.split(/\s+/) : []),
  ];
  return findThreadByRfc822(db, refs) ?? newId;
}

/**
 * Persist a prepared message row + its attachments with the given id/thread/
 * labels. Does NOT bump history or write an outbox row — callers do that.
 * Shared by send and draft create/update.
 */
export function persistPrepared(
  db: Database,
  prep: PreparedSend,
  args: { id: string; threadId: string; labels: string[]; internalDate: number },
): void {
  const { normalized } = prep;
  const resource: GmailMessage = {
    id: args.id,
    threadId: args.threadId,
    snippet: prep.snippet,
    historyId: "0",
    internalDate: String(args.internalDate),
    sizeEstimate: prep.raw.length,
    payload: prep.payload,
  };
  insertMessage(db, {
    id: args.id,
    threadId: args.threadId,
    internalDate: args.internalDate,
    historyId: 0,
    sizeEstimate: prep.raw.length,
    snippet: prep.snippet,
    subject: normalized.subject,
    fromAddr: normalized.from,
    toAddrs: normalized.to,
    ccAddrs: normalized.cc ?? null,
    bccAddrs: normalized.bcc ?? null,
    rfc822MessageId: normalized.messageId ?? null,
    inReplyTo: normalized.inReplyTo ?? null,
    hasAttachment: prep.hasAttachment,
    bodyText: prep.bodyText,
    rawJson: JSON.stringify(resource),
    rawRfc822: prep.raw.toString("utf8"),
    isSandboxCreated: true,
    labelIds: args.labels,
  });
  if (normalized.attachments) {
    for (const att of normalized.attachments) {
      insertAttachment(db, {
        messageId: args.id,
        attachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.content?.length ?? att.size,
        data: att.content ?? null,
      });
    }
  }
}

/** Sync: commit a prepared message as sent. MUST run inside a transaction. */
export function commitSend(db: Database, prep: PreparedSend, opts: SendOptions = {}): SendResult {
  const id = newMessageId();
  const threadId = resolveThreadId(db, prep, id, opts.threadId);
  const internalDate = Date.now();
  const labels = opts.labels ?? ["SENT"];

  persistPrepared(db, prep, { id, threadId, labels, internalDate });

  const envelopeTo = [
    ...splitAddrs(prep.normalized.to),
    ...splitAddrs(prep.normalized.cc),
    ...splitAddrs(prep.normalized.bcc),
  ];
  insertOutbox(db, { messageId: id, envelopeTo, rawRfc822: prep.raw.toString("utf8"), createdAt: internalDate });
  bumpMessageHistory(db, [id]);

  const row = getMessageRow(db, id)!;
  return { message: shapeMessage(row, getLabelIds(db, id), "full"), messageId: id, threadId };
}
