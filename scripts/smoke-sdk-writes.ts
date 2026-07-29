import type { gmail_v1 } from "googleapis";
import { b64urlEncode } from "../src/lib/gmail/base64.js";

// Part 2 of the acceptance harness: exercise every mutation through the official
// SDK, then verify reset restores the snapshot while the audit trail survives.

interface Ctx {
  gmail: gmail_v1.Gmail;
  check: (name: string, cond: boolean, detail?: unknown) => void;
  expectError: (name: string, fn: () => Promise<unknown>, code: number) => Promise<void>;
}

const PORT = process.env.PORT || "3100";
const ROOT = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;

interface RawParts {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

function buildRaw(p: RawParts): string {
  const lines = [
    `From: ${p.from}`,
    `To: ${p.to}`,
    `Subject: ${p.subject}`,
    `Message-ID: ${p.messageId ?? `<${Math.abs(hashCode(p.subject))}@smoke.sandbox.local>`}`,
  ];
  if (p.inReplyTo) lines.push(`In-Reply-To: ${p.inReplyTo}`);
  if (p.references) lines.push(`References: ${p.references}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"', "MIME-Version: 1.0", "", p.text);
  return b64urlEncode(lines.join("\r\n"));
}

// Deterministic-ish id source (avoids Math.random in labels/messages).
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function headerOf(msg: gmail_v1.Schema$Message, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    undefined;
}

export async function part2Writes({ gmail, check, expectError }: Ctx): Promise<void> {
  console.log("\n\x1b[1mPart 2 — Writes (mutations, send, drafts, reset)\x1b[0m");
  const userId = "me";

  // --- labels.create + modify ------------------------------------------------
  const created = await gmail.users.labels.create({
    userId,
    requestBody: { name: `Smoke ${Date.now()}` },
  });
  const labelId = created.data.id!;
  check("labels.create returns a Label_N id", /^Label_\d+$/.test(labelId), created.data);

  const inbox = await gmail.users.messages.list({ userId, labelIds: ["INBOX"], maxResults: 5 });
  const targetId = inbox.data.messages![0].id!;
  await gmail.users.messages.modify({
    userId,
    id: targetId,
    requestBody: { addLabelIds: [labelId], removeLabelIds: ["UNREAD"] },
  });
  const afterModify = await gmail.users.messages.get({ userId, id: targetId, format: "minimal" });
  check("modify adds label", (afterModify.data.labelIds ?? []).includes(labelId));
  check("modify removes UNREAD", !(afterModify.data.labelIds ?? []).includes("UNREAD"));

  // --- send ------------------------------------------------------------------
  const raw = buildRaw({
    from: "sandbox.user@gmail.com",
    to: "colleague@example.com",
    subject: "Smoke: hello from the sandbox",
    text: "This message never leaves the machine.",
  });
  const sent = await gmail.users.messages.send({ userId, requestBody: { raw } });
  const sentId = sent.data.id!;
  check("send returns a message id", !!sentId);
  check("sent message has SENT label", (sent.data.labelIds ?? []).includes("SENT"));
  const outbox1 = await fetch(`${ROOT}/api/activity`).then((r) => r.json());
  check(
    "sent message appears in outbox",
    (outbox1.outbox ?? []).some((o: { messageId: string }) => o.messageId === sentId),
  );

  // --- reply threading -------------------------------------------------------
  const original = await gmail.users.messages.get({ userId, id: targetId, format: "metadata" });
  const origMsgId = headerOf(original.data, "Message-ID");
  check("original message exposes a Message-ID header", !!origMsgId, original.data.payload?.headers);
  const replyRaw = buildRaw({
    from: "sandbox.user@gmail.com",
    to: "someone@example.com",
    subject: "Re: threaded reply",
    text: "Replying in-thread.",
    inReplyTo: origMsgId,
    references: origMsgId,
  });
  const reply = await gmail.users.messages.send({ userId, requestBody: { raw: replyRaw } });
  check(
    "reply joins the original thread via In-Reply-To",
    reply.data.threadId === original.data.threadId,
    { reply: reply.data.threadId, original: original.data.threadId },
  );

  // --- drafts lifecycle ------------------------------------------------------
  const draftRaw = buildRaw({
    from: "sandbox.user@gmail.com",
    to: "draft@example.com",
    subject: "Smoke: a draft",
    text: "draft body",
  });
  const draft = await gmail.users.drafts.create({ userId, requestBody: { message: { raw: draftRaw } } });
  const draftId = draft.data.id!;
  check("drafts.create returns a draft id distinct from message id", !!draftId && draftId !== draft.data.message?.id);
  const draftList = await gmail.users.drafts.list({ userId });
  check("drafts.list includes the new draft", (draftList.data.drafts ?? []).some((d) => d.id === draftId));
  const draftMsgId1 = draft.data.message?.id;
  const updated = await gmail.users.drafts.update({
    userId,
    id: draftId,
    requestBody: { message: { raw: buildRaw({ from: "sandbox.user@gmail.com", to: "draft@example.com", subject: "Smoke: a draft (edited)", text: "edited" }) } },
  });
  check("drafts.update assigns a NEW message id", updated.data.message?.id !== draftMsgId1);
  const draftSent = await gmail.users.drafts.send({ userId, requestBody: { id: draftId } });
  check("drafts.send returns a sent message with SENT label", (draftSent.data.labelIds ?? []).includes("SENT"));
  await expectError("draft is gone after send → 404", () => gmail.users.drafts.get({ userId, id: draftId }), 404);

  // --- trash / untrash -------------------------------------------------------
  const trashTarget = inbox.data.messages![1].id!;
  await gmail.users.messages.trash({ userId, id: trashTarget });
  const trashed = await gmail.users.messages.get({ userId, id: trashTarget, format: "minimal" });
  check("trash adds TRASH", (trashed.data.labelIds ?? []).includes("TRASH"));
  check("trash removes INBOX", !(trashed.data.labelIds ?? []).includes("INBOX"));
  const inboxAfterTrash = await gmail.users.messages.list({ userId, labelIds: ["INBOX"], maxResults: 50 });
  check(
    "trashed message excluded from INBOX listing",
    !(inboxAfterTrash.data.messages ?? []).some((m) => m.id === trashTarget),
  );
  await gmail.users.messages.untrash({ userId, id: trashTarget });
  const untrashed = await gmail.users.messages.get({ userId, id: trashTarget, format: "minimal" });
  check("untrash removes TRASH", !(untrashed.data.labelIds ?? []).includes("TRASH"));

  // --- batchModify -----------------------------------------------------------
  const batchIds = (inbox.data.messages ?? []).slice(2, 4).map((m) => m.id!);
  await gmail.users.messages.batchModify({ userId, requestBody: { ids: batchIds, addLabelIds: ["STARRED"] } });
  const starChecks = await Promise.all(
    batchIds.map((id) => gmail.users.messages.get({ userId, id, format: "minimal" })),
  );
  check("batchModify starred all targets", starChecks.every((r) => (r.data.labelIds ?? []).includes("STARRED")));

  // --- permanent delete ------------------------------------------------------
  await gmail.users.messages.delete({ userId, id: sentId });
  await expectError("deleted message → 404", () => gmail.users.messages.get({ userId, id: sentId }), 404);

  // --- reset restores snapshot; audit survives -------------------------------
  const beforeReset = await gmail.users.getProfile({ userId });
  const preResetActivity = await fetch(`${ROOT}/api/activity`).then((r) => r.json());
  const preResetActionCount = (preResetActivity.sessions ?? []).reduce(
    (n: number, s: { action_count: number }) => n + s.action_count,
    0,
  );
  check("audit recorded actions before reset", preResetActionCount > 0, preResetActionCount);

  const resetRes = await fetch(`${ROOT}/api/sandbox/reset`, { method: "POST" }).then((r) => r.json());
  check("reset endpoint returns ok", resetRes.status === "ok", resetRes);
  const afterReset = await gmail.users.getProfile({ userId });
  check(
    "reset restores message count to snapshot (18)",
    afterReset.data.messagesTotal === 18,
    { before: beforeReset.data.messagesTotal, after: afterReset.data.messagesTotal },
  );
  await expectError("previously-sent message gone after reset → 404", () =>
    gmail.users.messages.get({ userId, id: reply.data.id! }), 404);

  const postResetActivity = await fetch(`${ROOT}/api/activity`).then((r) => r.json());
  const postResetActionCount = (postResetActivity.sessions ?? []).reduce(
    (n: number, s: { action_count: number }) => n + s.action_count,
    0,
  );
  check(
    "audit trail survives reset (prior actions retained)",
    postResetActionCount >= preResetActionCount,
    { pre: preResetActionCount, post: postResetActionCount },
  );
}
