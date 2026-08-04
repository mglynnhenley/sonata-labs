import type { Database } from "better-sqlite3";
import { insertMessage, getMessageRow, messageIdsInThread } from "../store/messages";
import { nextHistoryId } from "../store/meta";
import { buildPayload, computeSnippet } from "../gmail/mime";
import { newMessageId, newHexId } from "../gmail/ids";
import type { GmailMessage } from "../gmail/types";
import { BadRequestError } from "./auth";
import type { SimTime } from "./types";

// Assembling one received message. Shared by /api/sandbox/inject and
// /api/sandbox/seed so a beat injected mid-run is byte-for-byte the same kind
// of artifact as one the world was seeded with — an agent must not be able to
// tell "arrived during the day" from "was already here".
//
// Mirrors the seed assembly path (src/lib/seed.ts): is_sandbox_created stays 0,
// no raw_rfc822, labelIds through the join table. Nothing here writes an audit
// row: the audit log is the AGENT's record and grading reads it, so the world's
// own moves must stay out of it.

export function joinAddrs(value: string | string[] | undefined): string {
  if (!value) return "";
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
}

/** Resolve simulated time, or fail loudly — never silently fall back to now. */
export function resolveAtMs(t: SimTime, what: string): number {
  if (typeof t.atMs === "number" && Number.isFinite(t.atMs)) return t.atMs;
  if (t.atISO) {
    const parsed = Date.parse(t.atISO);
    if (Number.isFinite(parsed)) return parsed;
    throw new BadRequestError(`${what}: atISO '${t.atISO}' is not a date`);
  }
  throw new BadRequestError(`${what}: atMs or atISO is required`);
}

export interface WriteEmailInput {
  from: string;
  /** Already-joined header value. */
  to: string;
  cc?: string;
  subject: string;
  body: string;
  atMs: number;
  labelIds: string[];
  /** Existing thread to land on; a new thread is minted when absent. */
  threadId?: string;
  /** RFC822 Message-ID this replies to, for In-Reply-To/References. */
  inReplyTo?: string;
  /**
   * Ids the caller already resolved. Only the world seeder supplies these: its
   * wire seed carries the ids the rest of the clone was threaded against, so
   * minting fresh ones here would break threading the twin cannot see.
   */
  id?: string;
  rfc822MessageId?: string;
}

export interface WrittenEmail {
  id: string;
  threadId: string;
  rfc822MessageId: string;
  historyId: number;
  internalDate: number;
}

/** Write one received message. Call inside the caller's transaction. */
export function writeEmail(db: Database, input: WriteEmailInput): WrittenEmail {
  const id = input.id ?? newMessageId();
  const rfc822MessageId = input.rfc822MessageId ?? `<sonata-${newHexId()}@mail.sandbox.local>`;
  const threadId = input.threadId ?? id;
  const historyId = nextHistoryId(db);

  const payload = buildPayload({
    from: input.from,
    to: input.to,
    cc: input.cc || undefined,
    subject: input.subject,
    date: new Date(input.atMs),
    messageId: rfc822MessageId,
    inReplyTo: input.inReplyTo,
    references: input.inReplyTo,
    text: input.body,
  });

  const snippet = computeSnippet(input.body);
  const sizeEstimate = input.body.length + input.subject.length + 200;
  const resource: GmailMessage = {
    id,
    threadId,
    snippet,
    historyId: String(historyId),
    internalDate: String(input.atMs),
    sizeEstimate,
    payload,
  };

  insertMessage(db, {
    id,
    threadId,
    internalDate: input.atMs,
    historyId,
    sizeEstimate,
    snippet,
    subject: input.subject,
    fromAddr: input.from,
    toAddrs: input.to,
    ccAddrs: input.cc || null,
    rfc822MessageId,
    inReplyTo: input.inReplyTo ?? null,
    hasAttachment: false,
    bodyText: input.body,
    rawJson: JSON.stringify(resource),
    isSandboxCreated: false,
    labelIds: input.labelIds,
  });

  return { id, threadId, rfc822MessageId, historyId, internalDate: input.atMs };
}

export interface ThreadAnchor {
  threadId: string;
  /** RFC822 id of the newest message in the thread, for In-Reply-To. */
  inReplyTo?: string;
}

/**
 * Resolve a caller's `threadRef` to a thread to land on. Accepts a message id or
 * a thread id, because the engine holds `{ id, containerId }` from the earlier
 * injection and either half should work. Returns null when the ref names
 * nothing — the caller posts standalone rather than failing the beat, since a
 * missing follow-up target must not take the whole run down.
 */
export function resolveThread(db: Database, ref: string): ThreadAnchor | null {
  const asMessage = getMessageRow(db, ref);
  const threadId = asMessage?.thread_id ?? ref;
  const ids = messageIdsInThread(db, threadId);
  if (ids.length === 0) return null;
  const newest = getMessageRow(db, ids[ids.length - 1]);
  return { threadId, inReplyTo: newest?.rfc822_message_id ?? undefined };
}
