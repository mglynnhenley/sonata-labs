// Opaque pageToken ⇄ {offset}. Google's tokens are opaque strings agents must
// not parse, so any stable encoding works. We base64url a tiny JSON blob, and
// decoding never throws — a garbage token is silently the first page, exactly as
// a caller who invented one deserves.

export interface PageState {
  offset: number;
}

export function encodePageToken(state: PageState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodePageToken(token: string | null | undefined): PageState {
  if (!token) return { offset: 0 };
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const offset = Number((JSON.parse(json) as { offset?: unknown }).offset);
    return { offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0 };
  } catch {
    return { offset: 0 };
  }
}

/**
 * The real Search method's page is 10000 rows, so that is both the default and
 * the cap. The seeded account fits in one page, which is exactly why an agent
 * that asks for pageSize 2 must actually get a nextPageToken back — otherwise
 * the paging path is dead code nobody ever exercises.
 */
export function clampPageSize(raw: unknown, def = 10_000): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 10_000) return def;
  return Math.floor(n);
}
