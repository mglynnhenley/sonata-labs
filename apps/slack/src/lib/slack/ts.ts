import type { Database } from "better-sqlite3";

// Slack message identity: `ts` is a string "seconds.micros" (micros always six
// digits, e.g. "1699999999.001200"). It is BOTH the message id and the sort /
// pagination anchor, and must be strictly increasing per channel. Because the
// seconds part is fixed-width (10 digits until 2286) and micros are
// zero-padded, lexical order == numeric order — we rely on that in SQL.

export function formatTs(seconds: number, micros: number): string {
  return `${Math.floor(seconds)}.${String(micros).padStart(6, "0")}`;
}

export function tsToMs(ts: string): number {
  const [s, us = "0"] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(us.padEnd(6, "0")) / 1000);
}

export function msToTs(ms: number, extraMicros = 0): string {
  const seconds = Math.floor(ms / 1000);
  const micros = (ms % 1000) * 1000 + extraMicros;
  return formatTs(seconds + Math.floor(micros / 1_000_000), micros % 1_000_000);
}

export function compareTs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ts + 1 microsecond. */
export function bumpTs(ts: string): string {
  const [s, us] = ts.split(".");
  const micros = Number(us ?? "0") + 1;
  if (micros >= 1_000_000) return formatTs(Number(s) + 1, micros - 1_000_000);
  return formatTs(Number(s), micros);
}

/**
 * Mint the next ts for a channel: wall clock now, but never <= the newest
 * existing ts in the channel (reused ts = silent client dedupe bugs).
 * Call inside the mutation's transaction so two concurrent posts can't race.
 */
export function mintTs(db: Database, channelId: string, nowMs = Date.now()): string {
  const candidate = msToTs(nowMs);
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM messages WHERE channel_id = ?")
    .get(channelId) as { ts: string | null };
  if (row.ts && compareTs(candidate, row.ts) <= 0) return bumpTs(row.ts);
  return candidate;
}
