import { b64urlDecode } from "../gmail/base64";
import { computeSnippet, stripHtml } from "../gmail/mime";
import type { GmailMessage, GmailPayload } from "../gmail/types";
import type { InsertMessageInput } from "../store/messages";

// Transform a real format=full Gmail Message resource (from the sync CLI) into a
// sandbox message row. labelIds are pulled out to message_labels; the payload is
// stored as-is in raw_json (with labelIds stripped) so reads are byte-faithful.

export function headerMap(payload: GmailPayload | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of payload?.headers ?? []) {
    if (h.name && h.value && !map.has(h.name.toLowerCase())) {
      map.set(h.name.toLowerCase(), h.value);
    }
  }
  return map;
}

/** Walk the payload collecting decoded text (prefers text/plain, falls back to stripped html). */
export function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const plains: string[] = [];
  const htmls: string[] = [];
  const walk = (part: GmailPayload) => {
    const mime = part.mimeType || "";
    if (part.body?.data) {
      const text = b64urlDecode(part.body.data).toString("utf8");
      if (mime === "text/plain") plains.push(text);
      else if (mime === "text/html") htmls.push(text);
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload);
  if (plains.length) return plains.join("\n").trim();
  if (htmls.length) return stripHtml(htmls.join("\n"));
  return "";
}

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function collectAttachments(payload: GmailPayload | undefined): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (part: GmailPayload) => {
    if (part.body?.attachmentId) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename || "attachment",
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload ?? {});
  return out;
}

/** Strip labelIds and (optionally) attachment body data from a payload copy. */
function stripLabelIds(msg: GmailMessage): GmailMessage {
  const copy: GmailMessage = { ...msg };
  delete copy.labelIds;
  return copy;
}

export function messageToRow(msg: GmailMessage): {
  input: Omit<InsertMessageInput, "labelIds">;
  labelIds: string[];
  attachments: AttachmentRef[];
} {
  const headers = headerMap(msg.payload);
  const bodyText = extractBodyText(msg.payload);
  const internalDate = Number(msg.internalDate ?? "0");
  const attachments = collectAttachments(msg.payload);

  const input: Omit<InsertMessageInput, "labelIds"> = {
    id: msg.id!,
    threadId: msg.threadId ?? msg.id!,
    internalDate,
    historyId: Number(msg.historyId ?? "0"),
    sizeEstimate: msg.sizeEstimate ?? 0,
    snippet: msg.snippet || computeSnippet(bodyText),
    subject: headers.get("subject") ?? null,
    fromAddr: headers.get("from") ?? null,
    toAddrs: headers.get("to") ?? null,
    ccAddrs: headers.get("cc") ?? null,
    bccAddrs: headers.get("bcc") ?? null,
    rfc822MessageId: headers.get("message-id") ?? null,
    inReplyTo: headers.get("in-reply-to") ?? null,
    hasAttachment: attachments.length > 0,
    bodyText,
    rawJson: JSON.stringify(stripLabelIds(msg)),
    rawRfc822: null, // synced messages have no stored raw (format=raw → 400)
    isSandboxCreated: false,
  };

  return { input, labelIds: msg.labelIds ?? [], attachments };
}
