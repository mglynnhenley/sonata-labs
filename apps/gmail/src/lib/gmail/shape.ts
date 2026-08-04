import { b64urlEncode } from "./base64";
import type { GmailMessage, GmailPayload, MessageRow, MessageFormat } from "./types";

// ---------------------------------------------------------------------------
// The fidelity linchpin. raw_json holds a format=full Gmail Message resource
// with labelIds STRIPPED; message_labels is the live source of truth for
// labels. Every read overlays current labelIds + historyId, then shapes to the
// requested format. Get this right and the official SDK can't tell the sandbox
// from real Gmail.
// ---------------------------------------------------------------------------

function baseFields(row: MessageRow, labelIds: string[]): GmailMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    labelIds,
    snippet: row.snippet,
    historyId: String(row.history_id),
    internalDate: String(row.internal_date),
    sizeEstimate: row.size_estimate,
  };
}

/** Deep-clone a payload while removing body.data (metadata format). */
function stripBodyData(part: GmailPayload): GmailPayload {
  const out: GmailPayload = {
    partId: part.partId,
    mimeType: part.mimeType,
    filename: part.filename,
    headers: part.headers,
  };
  if (part.body) {
    out.body = {
      ...part.body,
      data: undefined,
    };
  }
  if (part.parts) out.parts = part.parts.map(stripBodyData);
  return out;
}

function filterHeaders(payload: GmailPayload, names: string[]): GmailPayload {
  if (!names.length || !payload.headers) return payload;
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return {
    ...payload,
    headers: payload.headers.filter((h) => h.name && lower.has(h.name.toLowerCase())),
  };
}

/**
 * Shape a stored message row into a Gmail Message resource.
 * `raw` format is only valid for sandbox-created messages (raw_rfc822 present);
 * callers should check `canReturnRaw` first and 400 otherwise.
 */
export function shapeMessage(
  row: MessageRow,
  labelIds: string[],
  format: MessageFormat = "full",
  metadataHeaders: string[] = [],
): GmailMessage {
  const base = baseFields(row, labelIds);

  if (format === "minimal") {
    return base;
  }

  if (format === "raw") {
    return {
      ...base,
      raw: row.raw_rfc822 ? b64urlEncode(row.raw_rfc822) : undefined,
    };
  }

  // full / metadata both need the payload from raw_json.
  const full = JSON.parse(row.raw_json) as GmailMessage;
  let payload = full.payload;

  if (payload && format === "metadata") {
    payload = stripBodyData(payload);
    if (metadataHeaders.length) payload = filterHeaders(payload, metadataHeaders);
  }

  return {
    ...base,
    payload,
    // Preserve raw_json's estimate if the row's is 0 (older seeds).
    sizeEstimate: base.sizeEstimate || full.sizeEstimate,
  };
}

export function canReturnRaw(row: MessageRow): boolean {
  return !!row.raw_rfc822;
}
