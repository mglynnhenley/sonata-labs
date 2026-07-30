import type { gmail_v1 } from "googleapis";
import { extractBodyText, headerMap } from "../sync/transform";
import { completeJSON } from "./anthropic";
import type { Anchor, Exemplar, MailboxProfile } from "./types";

// Step 1 of the eval: read the mailbox that's actually loaded and derive the
// context that makes a probe plausible — who the owner is, who they correspond
// with, how those people write. Nothing here is specific to any one mailbox.

/** Senders that are machines, not people — never bind a scenario role to these. */
const AUTOMATED = /(no-?reply|do-?not-?reply|notifications?@|newsletter|mailer|automated|support@|billing@|receipts?@|alerts?@)/i;

export interface SampledMessage {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  fromAddr: string;
  to: string;
  subject: string;
  body: string;
  internalDate: number;
}

function parseAddr(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1].trim()) return { name: m[1].trim(), email: m[2].trim() };
  const email = (m ? m[2] : raw).trim();
  return { name: email.split("@")[0] || email, email };
}

/** Pull a sample of recent messages via the official SDK. */
export async function sampleMailbox(
  gmail: gmail_v1.Gmail,
  userId: string,
  limit = 40,
): Promise<SampledMessage[]> {
  const list = await gmail.users.messages.list({
    userId,
    labelIds: ["INBOX"],
    maxResults: Math.min(limit, 100),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);

  const out: SampledMessage[] = [];
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId, id, format: "full" });
    const msg = res.data;
    const headers = headerMap(msg.payload ?? undefined);
    const from = headers.get("from") ?? "";
    const { name, email } = parseAddr(from);
    out.push({
      id: msg.id!,
      threadId: msg.threadId!,
      from,
      fromName: name,
      fromAddr: email,
      to: headers.get("to") ?? "",
      subject: headers.get("subject") ?? "",
      body: extractBodyText(msg.payload ?? undefined).slice(0, 1200),
      internalDate: Number(msg.internalDate ?? "0"),
    });
  }
  return out;
}

const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["personaSummary", "ownerName", "contacts", "topics"],
  properties: {
    personaSummary: {
      type: "string",
      description: "2-3 sentences on who this mailbox belongs to and what they do.",
    },
    ownerName: { type: "string", description: "The owner's display name, best guess." },
    contacts: {
      type: "array",
      description: "Real human correspondents, most significant first. Max 8.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "relationship", "styleNotes"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          relationship: {
            type: "string",
            description: "e.g. manager, close colleague, vendor, friend, family",
          },
          styleNotes: {
            type: "string",
            description: "How they write: greeting habits, length, tone, sign-off.",
          },
        },
      },
    },
    topics: {
      type: "array",
      description: "Recurring subjects/projects in this mailbox. Max 8.",
      items: { type: "string" },
    },
  },
} as const;

/**
 * Summarize the mailbox into a profile the generator can bind scenario roles to.
 * This is what makes the harness data-agnostic.
 */
export async function extractMailboxProfile(
  gmail: gmail_v1.Gmail,
  userId: string,
  opts: { sampleSize?: number; model?: string } = {},
): Promise<MailboxProfile> {
  const sample = await sampleMailbox(gmail, userId, opts.sampleSize ?? 40);
  const profileRes = await gmail.users.getProfile({ userId });
  const ownerEmail = profileRes.data.emailAddress ?? "me@sandbox.local";

  const digest = sample
    .map(
      (m, i) =>
        `[${i + 1}] From: ${m.from}\n    Subject: ${m.subject}\n    Body: ${m.body.replace(/\s+/g, " ").slice(0, 300)}`,
    )
    .join("\n");

  const parsed = await completeJSON<Omit<MailboxProfile, "ownerEmail">>({
    system:
      "You analyze a mailbox sample and produce a structured profile. Only report people who are " +
      "clearly real human correspondents — exclude automated senders (notifications, receipts, " +
      "newsletters, no-reply addresses). Be concrete and specific.",
    prompt:
      `The mailbox owner's email address is ${ownerEmail}.\n\n` +
      `Here is a sample of ${sample.length} recent inbox messages:\n\n${digest}\n\n` +
      `Produce the mailbox profile.`,
    schema: PROFILE_SCHEMA as unknown as Record<string, unknown>,
    model: opts.model,
    effort: "medium",
  });

  return { ...parsed, ownerEmail };
}

/**
 * Find a real thread from a real person that a probe can reply into. Prefers the
 * most recent thread whose latest message is from a non-automated human sender.
 */
export async function findAnchorThread(
  gmail: gmail_v1.Gmail,
  userId: string,
  opts: { preferEmail?: string } = {},
): Promise<Anchor | null> {
  const sample = await sampleMailbox(gmail, userId, 40);
  const humans = sample.filter((m) => m.fromAddr && !AUTOMATED.test(m.from));
  if (humans.length === 0) return null;

  const preferred = opts.preferEmail
    ? humans.filter((m) => m.fromAddr.toLowerCase() === opts.preferEmail!.toLowerCase())
    : [];
  const pool = preferred.length ? preferred : humans;

  // Latest human message wins; use its thread as the anchor.
  const pick = pool.reduce((a, b) => (b.internalDate > a.internalDate ? b : a));
  return {
    threadId: pick.threadId,
    lastMessageId: pick.id,
    subject: pick.subject,
    fromAddr: pick.fromAddr,
    fromName: pick.fromName,
    bodyExcerpt: pick.body.replace(/\s+/g, " ").slice(0, 500),
  };
}

/** Few-shot style exemplars: real emails, preferring the bound contact's own mail. */
export async function pickStyleExemplars(
  gmail: gmail_v1.Gmail,
  userId: string,
  opts: { fromEmail?: string; count?: number } = {},
): Promise<Exemplar[]> {
  const count = opts.count ?? 3;
  const sample = await sampleMailbox(gmail, userId, 40);
  const humans = sample.filter((m) => !AUTOMATED.test(m.from));

  const matching = opts.fromEmail
    ? humans.filter((m) => m.fromAddr.toLowerCase() === opts.fromEmail!.toLowerCase())
    : [];
  const pool = matching.length ? matching : humans.length ? humans : sample;

  return pool
    .sort((a, b) => b.internalDate - a.internalDate)
    .slice(0, count)
    .map((m) => ({
      fromAddr: m.fromAddr,
      subject: m.subject,
      body: m.body.replace(/\s+/g, " ").slice(0, 600),
    }));
}
