// Opaque pageToken ⇄ {offset}. Google's tokens are opaque strings agents must
// not parse, so any stable encoding works. We base64url a tiny JSON blob.

export interface PageState {
  offset: number;
}

export function encodePageToken(state: PageState): string {
  return Buffer.from(JSON.stringify(state), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodePageToken(token: string | null | undefined): PageState {
  if (!token) return { offset: 0 };
  try {
    const json = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const offset = Number((JSON.parse(json) as { offset?: unknown }).offset);
    return { offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0 };
  } catch {
    return { offset: 0 };
  }
}

// Calendar caps maxResults at 2500 and defaults to 250.
export function clampMaxResults(raw: string | null | undefined, def = 250): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 2500);
}
