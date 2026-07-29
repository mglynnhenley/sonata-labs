import { b64urlEncode, b64urlDecodeToString } from "./base64";

// Opaque pageToken ⇄ {offset}. Gmail's tokens are opaque strings; agents must
// not parse them, so any stable encoding works. We base64url a tiny JSON blob.

export interface PageState {
  offset: number;
}

export function encodePageToken(state: PageState): string {
  return b64urlEncode(JSON.stringify(state));
}

export function decodePageToken(token: string | null | undefined): PageState {
  if (!token) return { offset: 0 };
  try {
    const parsed = JSON.parse(b64urlDecodeToString(token));
    const offset = Number(parsed?.offset);
    return { offset: Number.isFinite(offset) && offset >= 0 ? offset : 0 };
  } catch {
    return { offset: 0 };
  }
}

// Gmail caps maxResults at 500 and defaults to 100.
export function clampMaxResults(raw: string | null | undefined, def = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 500);
}
