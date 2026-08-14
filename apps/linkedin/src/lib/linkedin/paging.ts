// LinkedIn pages by index, not by opaque cursor. This file sits in the slot
// where the Gmail and Calendar clones keep `pagination.ts`, and it looks nothing
// like them on purpose: a base64 pageToken would be LESS faithful here, because
// the real API returns `paging: {start, count, links}` and agents build the next
// request by incrementing `start` themselves.
//
// `total` is per-endpoint at LinkedIn, not blanket. The posts author finder and
// organizationAcls do not return it; the socialActions comments finder does. So
// it is optional here and each route passes it only where the vendor does —
// emitting it everywhere would teach an agent to read a field that comes back
// undefined against the real API.

/** LinkedIn's real default and cap for the posts finder. */
export function clampCount(raw: string | null, def = 10, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Non-numeric or negative becomes 0; this never throws and never 400s. */
export function parseStart(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export interface PagingLink {
  type: "application/json";
  rel: "next";
  href: string;
}

export interface Paging {
  start: number;
  count: number;
  total?: number;
  links: PagingLink[];
}

/**
 * `links` is empty unless more rows remain. Never emit a `next` link on the
 * last page: an agent that follows one gets an empty `elements` array and
 * concludes the world is empty.
 */
export function buildPaging(opts: {
  start: number;
  count: number;
  hasMore: boolean;
  total?: number;
  nextHref?: string;
}): Paging {
  const links: PagingLink[] =
    opts.hasMore && opts.nextHref
      ? [{ type: "application/json", rel: "next", href: opts.nextHref }]
      : [];
  return opts.total === undefined
    ? { start: opts.start, count: opts.count, links }
    : { start: opts.start, count: opts.count, total: opts.total, links };
}

/**
 * The `next` href in the documented form — every incoming parameter preserved,
 * only `start` replaced, keys sorted so the href is stable across runs and a
 * test can assert on it.
 */
export function nextHref(pathname: string, params: URLSearchParams, nextStart: number): string {
  const next = new URLSearchParams(params);
  next.set("start", String(nextStart));
  next.sort();
  return `${pathname}?${next.toString()}`;
}
