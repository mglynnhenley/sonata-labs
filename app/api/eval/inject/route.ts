import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { insertMessage, getMessageRow } from "@/lib/store/messages";
import { nextHistoryId, getProfileEmail } from "@/lib/store/meta";
import { buildPayload, computeSnippet } from "@/lib/gmail/mime";
import { newMessageId, newHexId } from "@/lib/gmail/ids";
import type { GmailMessage } from "@/lib/gmail/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inject eval fixture messages as ordinary received mail. Mirrors the seed
// assembly path (src/lib/seed.ts) so probes are indistinguishable from synced
// messages: is_sandbox_created stays 0, no raw_rfc822, labelIds via the join
// table. Deliberately NOT audit-logged — injection is test setup, not agent
// behavior, and the grader reads the audit log to judge the agent.
//
// Internal route (no bearer auth), like /api/sandbox/reset.

interface InboundMessage {
  slotId?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  minutesAgo?: number;
  labels?: string[];
  /** Thread onto an earlier message in this same batch, by slotId. */
  replyToSlotId?: string;
  /** Thread onto an existing (real) message already in the mailbox. */
  replyToRealMessageId?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { messages?: InboundMessage[] };
    const inbound = body.messages ?? [];
    if (inbound.length === 0) {
      return NextResponse.json({ error: "no messages supplied" }, { status: 400 });
    }

    const db = getDb();
    const ownerEmail = getProfileEmail(db);
    const now = Date.now();

    // Oldest first, so a later message can reference an earlier one's thread.
    const ordered = [...inbound].sort(
      (a, b) => (b.minutesAgo ?? 0) - (a.minutesAgo ?? 0),
    );

    const injected: Array<{
      slotId: string;
      id: string;
      threadId: string;
      rfc822MessageId: string;
    }> = [];

    const inject = db.transaction(() => {
      for (const m of ordered) {
        const id = newMessageId();
        const slotId = m.slotId ?? id;
        const rfc822MessageId = `<eval-${newHexId()}@mail.sandbox.local>`;
        const internalDate = now - (m.minutesAgo ?? 0) * 60_000;

        // Resolve threading: a prior slot in this batch, or a real message.
        let threadId = id;
        let inReplyTo: string | null = null;

        if (m.replyToSlotId) {
          const prior = injected.find((p) => p.slotId === m.replyToSlotId);
          if (prior) {
            threadId = prior.threadId;
            inReplyTo = prior.rfc822MessageId;
          }
        } else if (m.replyToRealMessageId) {
          const row = getMessageRow(db, m.replyToRealMessageId);
          if (row) {
            threadId = row.thread_id;
            inReplyTo = row.rfc822_message_id;
          }
        }

        const historyId = nextHistoryId(db);
        const payload = buildPayload({
          from: m.from,
          to: m.to || ownerEmail,
          subject: m.subject,
          date: new Date(internalDate),
          messageId: rfc822MessageId,
          inReplyTo: inReplyTo ?? undefined,
          references: inReplyTo ?? undefined,
          text: m.text,
        });

        const snippet = computeSnippet(m.text);
        const sizeEstimate = m.text.length + m.subject.length + 200;
        const resource: GmailMessage = {
          id,
          threadId,
          snippet,
          historyId: String(historyId),
          internalDate: String(internalDate),
          sizeEstimate,
          payload,
        };

        insertMessage(db, {
          id,
          threadId,
          internalDate,
          historyId,
          sizeEstimate,
          snippet,
          subject: m.subject,
          fromAddr: m.from,
          toAddrs: m.to || ownerEmail,
          rfc822MessageId,
          inReplyTo,
          hasAttachment: false,
          bodyText: m.text,
          rawJson: JSON.stringify(resource),
          isSandboxCreated: false,
          labelIds: m.labels ?? ["INBOX", "UNREAD"],
        });

        injected.push({ slotId, id, threadId, rfc822MessageId });
      }
    });

    inject();
    return NextResponse.json({ injected });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
