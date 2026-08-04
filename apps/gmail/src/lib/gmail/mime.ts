import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { b64urlEncode } from "./base64";
import type { GmailPayload, GmailHeader } from "./types";

// ---------------------------------------------------------------------------
// Snippet: Gmail shows ~short plain-text preview, whitespace-collapsed, no tags.
// ---------------------------------------------------------------------------
export function computeSnippet(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

function header(name: string, value: string): GmailHeader {
  return { name, value };
}

function addrList(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return "";
  const arr = Array.isArray(a) ? a : [a];
  return arr.map((x) => x.text).filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Normalized fields we can build a Gmail payload tree from — used both by the
// send pipeline (parsed from RFC822) and the seed generator (constructed).
// ---------------------------------------------------------------------------
export interface NormalizedMail {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: Date;
  messageId?: string; // RFC822 Message-ID (with angle brackets)
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
    content?: Buffer; // omitted if over cap
  }>;
  extraHeaders?: GmailHeader[];
}

function topHeaders(m: NormalizedMail): GmailHeader[] {
  const h: GmailHeader[] = [];
  if (m.messageId) h.push(header("Message-ID", m.messageId));
  h.push(header("Date", m.date.toUTCString()));
  h.push(header("From", m.from));
  h.push(header("To", m.to));
  if (m.cc) h.push(header("Cc", m.cc));
  if (m.bcc) h.push(header("Bcc", m.bcc));
  h.push(header("Subject", m.subject));
  if (m.inReplyTo) h.push(header("In-Reply-To", m.inReplyTo));
  if (m.references) h.push(header("References", m.references));
  h.push(header("MIME-Version", "1.0"));
  if (m.extraHeaders) h.push(...m.extraHeaders);
  return h;
}

function textPart(partId: string, mime: string, content: string): GmailPayload {
  const data = b64urlEncode(content);
  return {
    partId,
    mimeType: mime,
    filename: "",
    headers: [header("Content-Type", `${mime}; charset="UTF-8"`)],
    body: { size: Buffer.byteLength(content, "utf8"), data },
  };
}

function attachmentPart(
  partId: string,
  att: NonNullable<NormalizedMail["attachments"]>[number],
): GmailPayload {
  return {
    partId,
    mimeType: att.mimeType,
    filename: att.filename,
    headers: [
      header("Content-Type", `${att.mimeType}; name="${att.filename}"`),
      header("Content-Disposition", `attachment; filename="${att.filename}"`),
      header("Content-Transfer-Encoding", "base64"),
    ],
    body: { attachmentId: att.attachmentId, size: att.size },
  };
}

/**
 * Build a Gmail payload tree from normalized fields. Mirrors the structures
 * Gmail actually returns: text/plain alone, multipart/alternative for
 * text+html, multipart/mixed wrapper when attachments are present.
 */
export function buildPayload(m: NormalizedMail): GmailPayload {
  const headers = topHeaders(m);
  const bodyParts: GmailPayload[] = [];

  if (m.text != null && m.html != null) {
    const alt: GmailPayload = {
      partId: "0",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [header("Content-Type", "multipart/alternative")],
      parts: [textPart("0.0", "text/plain", m.text), textPart("0.1", "text/html", m.html)],
    };
    bodyParts.push(alt);
  } else if (m.html != null) {
    bodyParts.push(textPart("0", "text/html", m.html));
  } else {
    bodyParts.push(textPart("0", "text/plain", m.text ?? ""));
  }

  const attachments = m.attachments ?? [];

  // No attachments: the single body part IS the payload. Merge the top-level
  // headers (From/To/Subject/…) with the part's own Content-Type header.
  if (attachments.length === 0) {
    const only = bodyParts[0];
    return {
      partId: "",
      mimeType: only.mimeType,
      filename: "",
      headers: [...headers, ...(only.headers ?? [])],
      body: only.body,
      parts: only.parts,
    };
  }

  // Attachments present: multipart/mixed wrapper.
  const parts: GmailPayload[] = [...bodyParts];
  attachments.forEach((att, i) => parts.push(attachmentPart(String(i + 1), att)));
  return {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [...headers, header("Content-Type", "multipart/mixed")],
    parts,
  };
}

// ---------------------------------------------------------------------------
// Parse an RFC822 buffer (from send `raw`) into normalized fields + payload.
// ---------------------------------------------------------------------------
export interface ParsedSend {
  normalized: NormalizedMail;
  payload: GmailPayload;
  bodyText: string;
  snippet: string;
  hasAttachment: boolean;
}

export async function parseRfc822(raw: Buffer): Promise<ParsedSend> {
  const parsed: ParsedMail = await simpleParser(raw);
  const attachments = (parsed.attachments ?? []).map((a, i) => ({
    filename: a.filename || `attachment-${i + 1}`,
    mimeType: a.contentType || "application/octet-stream",
    size: a.size || a.content?.length || 0,
    attachmentId: "", // assigned by caller when persisting
    content: a.content,
  }));

  const normalized: NormalizedMail = {
    from: addrList(parsed.from),
    to: addrList(parsed.to),
    cc: addrList(parsed.cc) || undefined,
    bcc: addrList(parsed.bcc) || undefined,
    subject: parsed.subject || "",
    date: parsed.date || new Date(),
    messageId: parsed.messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: Array.isArray(parsed.references)
      ? parsed.references.join(" ")
      : parsed.references || undefined,
    text: parsed.text || (parsed.html ? undefined : ""),
    html: typeof parsed.html === "string" ? parsed.html : undefined,
    attachments: attachments.length ? attachments : undefined,
  };

  const bodyText = parsed.text || stripHtml(typeof parsed.html === "string" ? parsed.html : "");
  const payload = buildPayload(normalized);
  return {
    normalized,
    payload,
    bodyText,
    snippet: computeSnippet(bodyText),
    hasAttachment: attachments.length > 0,
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
