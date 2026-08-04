// The small amount of MIME the engine needs to read and write Gmail over the
// wire. Mirrors apps/gmail's src/lib/sync/transform.ts and src/lib/gmail/base64.ts
// (not importable from a workspace package — see trace.ts) and nothing more: the
// twin does the hard parts, and the engine only ever composes plain-text mail.

export interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

export function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** First value wins, lower-cased keys — the same contract the twin's parser uses. */
export function headerMap(payload: GmailPayload | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of payload?.headers ?? []) {
    if (h.name && h.value && !map.has(h.name.toLowerCase())) {
      map.set(h.name.toLowerCase(), h.value);
    }
  }
  return map;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decoded text, preferring text/plain and falling back to stripped HTML. */
export function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const plains: string[] = [];
  const htmls: string[] = [];
  const walk = (part: GmailPayload): void => {
    const mime = part.mimeType || "";
    if (part.body?.data) {
      const text = b64urlDecode(part.body.data);
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

/**
 * One RFC822 assembly for every tool that composes mail. Headers with no value
 * are dropped rather than emitted empty — an empty In-Reply-To costs threading.
 */
export function rfc822(headers: Record<string, string | undefined>, body: string): string {
  return [
    ...Object.entries(headers)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}: ${value}`),
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
  return /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/**
 * Every address in an address header. Matching addresses beats splitting on
 * commas, which display names contain: "Doe, Jane" <jane@x.com>.
 */
export function addressesIn(header: string): string[] {
  return [...header.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0]);
}
