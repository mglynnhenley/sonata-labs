import { SlackError } from "./envelope";

// Opaque cursor pagination. Slack cursors are base64 of an anchor (the real
// ones look like "dXNlcjpVMDYxTkZUVDI=" = "user:U061NFT..."); ours encode the
// last-seen sort key. `response_metadata.next_cursor` must be EMPTY/omitted on
// the last page — echoing a non-empty cursor forever makes client.paginate()
// loop forever.

export function encodeCursor(anchor: string): string {
  return Buffer.from(`a:${anchor}`, "utf8").toString("base64");
}

/** @returns the anchor, or null when no cursor was supplied. */
export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, "base64").toString("utf8");
    if (s.startsWith("a:")) return s.slice(2);
  } catch {
    // fall through
  }
  throw new SlackError("invalid_cursor");
}

/** Standard response_metadata: next_cursor set when more, empty when done. */
export function cursorMeta(nextAnchor: string | null): { next_cursor: string } {
  return { next_cursor: nextAnchor ? encodeCursor(nextAnchor) : "" };
}
