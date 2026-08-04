import type { EventRow } from "./shape";
import { expandEventRows } from "./recurrence";
import { passthroughOf } from "./shape";

// Busy-block arithmetic. Shared by the freeBusy endpoint and the UI's
// "find a slot" affordance, so both agree on what "free" means.

export interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Clip to the window, drop empties, then merge overlapping *and* touching
 * blocks. Google collapses back-to-back meetings into one busy span; an agent
 * looking for a gap must not see a zero-width one between 10:00 and 10:00.
 */
export function mergeBusy(
  intervals: Interval[],
  windowStartMs: number,
  windowEndMs: number,
): Interval[] {
  const clipped = intervals
    .map((i) => ({
      startMs: Math.max(i.startMs, windowStartMs),
      endMs: Math.min(i.endMs, windowEndMs),
    }))
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Interval[] = [];
  for (const i of clipped) {
    const last = merged[merged.length - 1];
    if (last && i.startMs <= last.endMs) {
      if (i.endMs > last.endMs) last.endMs = i.endMs;
    } else {
      merged.push({ ...i });
    }
  }
  return merged;
}

/** The complement of `busy` inside the window — the bookable gaps. */
export function freeGaps(
  busy: Interval[],
  windowStartMs: number,
  windowEndMs: number,
): Interval[] {
  const merged = mergeBusy(busy, windowStartMs, windowEndMs);
  const gaps: Interval[] = [];
  let cursor = windowStartMs;
  for (const block of merged) {
    if (block.startMs > cursor) gaps.push({ startMs: cursor, endMs: block.startMs });
    cursor = Math.max(cursor, block.endMs);
  }
  if (cursor < windowEndMs) gaps.push({ startMs: cursor, endMs: windowEndMs });
  return gaps;
}

/**
 * Does an event occupy its owner's time? Cancelled and transparent ("free")
 * events don't, and neither does one the calendar's owner declined — matching
 * what Google reports in freeBusy.
 */
export function occupiesTime(row: EventRow, declinedBy: Set<string>): boolean {
  if (row.status === "cancelled") return false;
  const extra = passthroughOf(row.raw_json ? JSON.parse(row.raw_json) : null);
  if (extra.transparency === "transparent") return false;
  return !declinedBy.has(row.id);
}

/**
 * Busy blocks for a set of stored rows over a window: expand recurrence, drop
 * the events that don't occupy time, then merge.
 */
export function busyBlocks(
  rows: EventRow[],
  windowStartMs: number,
  windowEndMs: number,
  calendarTimeZone: string,
  declinedBy: Set<string> = new Set(),
): Interval[] {
  const kept = rows.filter((r) => occupiesTime(r, declinedBy));
  const expanded = expandEventRows(kept, windowStartMs, windowEndMs, calendarTimeZone);
  return mergeBusy(
    expanded.map((e) => ({ startMs: e.startMs, endMs: e.endMs })),
    windowStartMs,
    windowEndMs,
  );
}
