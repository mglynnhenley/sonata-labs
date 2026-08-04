import { instanceId } from "./ids";
import type { EventRow } from "./shape";
import {
  addDaysPreservingWallClock,
  parseIcalDate,
  weekdayIn,
  WEEKDAY_CODES,
  type WeekdayCode,
} from "./time";

// ---------------------------------------------------------------------------
// Recurrence. RRULE lines are stored VERBATIM (recurrence_json) and echoed back
// unchanged, so anything an agent writes survives a round-trip even if we can't
// expand it.
//
// DELIBERATE LIMIT: expansion supports FREQ=DAILY and FREQ=WEEKLY only, with
// INTERVAL, COUNT, UNTIL, WKST, BYDAY (weekly) and EXDATE. That covers every
// recurring meeting a simulated workday contains — standups, weekly 1:1s,
// every-other-Thursday syncs. FREQ=MONTHLY/YEARLY, BYMONTHDAY, BYSETPOS and
// RDATE are NOT expanded: such an event is returned as its master only, even
// under singleEvents=true, and contributes only its master occurrence to
// freeBusy. Expanding those correctly needs a real iCalendar engine, and a
// half-right one would silently lie to the agent under test.
// ---------------------------------------------------------------------------

const MAX_OCCURRENCES = 750; // ~2 years of weekdays — the sandbox spans one day
const WEEKDAY_INDEX: Record<WeekdayCode, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export interface ParsedRrule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  count?: number;
  untilMs?: number;
  byDay: WeekdayCode[];
  wkst: WeekdayCode;
}

function isWeekday(value: string): value is WeekdayCode {
  return (WEEKDAY_CODES as readonly string[]).includes(value);
}

/** Parse one RRULE line. Returns null for rules we deliberately don't expand. */
export function parseRrule(line: string, timeZone = "UTC"): ParsedRrule | null {
  const body = line.replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const chunk of body.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq > 0) parts.set(chunk.slice(0, eq).trim().toUpperCase(), chunk.slice(eq + 1).trim());
  }
  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY") return null;

  const interval = Number(parts.get("INTERVAL") ?? "1");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : undefined;
  const untilRaw = parts.get("UNTIL");
  const untilMs = untilRaw ? (parseIcalDate(untilRaw, timeZone) ?? undefined) : undefined;
  const byDay = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((d) => d.trim().toUpperCase())
    // A numbered BYDAY ("2MO") is a monthly-style rule we don't expand — drop it
    // rather than silently treating it as every Monday.
    .filter(isWeekday);
  const wkstRaw = (parts.get("WKST") ?? "MO").toUpperCase();

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
    count: count !== undefined && Number.isFinite(count) && count > 0 ? Math.floor(count) : undefined,
    untilMs,
    byDay,
    wkst: isWeekday(wkstRaw) ? wkstRaw : "MO",
  };
}

/** EXDATE lines → the set of occurrence starts to skip (epoch ms). */
export function parseExdates(lines: string[], timeZone: string): Set<number> {
  const out = new Set<number>();
  for (const line of lines) {
    if (!/^EXDATE/i.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const tzid = /TZID=([^;:]+)/i.exec(line.slice(0, colon))?.[1];
    for (const value of line.slice(colon + 1).split(",")) {
      const ms = parseIcalDate(value, tzid ?? timeZone);
      if (ms !== null) out.add(ms);
    }
  }
  return out;
}

export interface Occurrence {
  startMs: number;
  endMs: number;
  /** The occurrence's own start — Google's originalStartTime for instances. */
  originalStartMs: number;
}

export interface ExpandOptions {
  startMs: number;
  endMs: number;
  allDay: boolean;
  timeZone: string;
  recurrence: string[];
  windowStartMs: number;
  windowEndMs: number;
  limit?: number;
}

/**
 * Expand a recurring event into the occurrences that overlap the window.
 * Returns a single occurrence (the master itself) when there is no rule we can
 * expand — see the limit note at the top of this file.
 */
export function expandRecurrence(opts: ExpandOptions): Occurrence[] {
  const duration = opts.endMs - opts.startMs;
  const rruleLine = opts.recurrence.find((l) => /^RRULE:/i.test(l));
  const rule = rruleLine ? parseRrule(rruleLine, opts.timeZone) : null;
  const master: Occurrence = {
    startMs: opts.startMs,
    endMs: opts.endMs,
    originalStartMs: opts.startMs,
  };
  if (!rule) {
    return overlaps(master, opts.windowStartMs, opts.windowEndMs) ? [master] : [];
  }

  const exdates = parseExdates(opts.recurrence, opts.timeZone);
  const limit = opts.limit ?? MAX_OCCURRENCES;
  const out: Occurrence[] = [];
  let emitted = 0; // counts toward COUNT, including EXDATE-skipped occurrences

  for (const dayOffset of dayOffsets(rule, opts.startMs, opts.timeZone, limit)) {
    if (rule.count !== undefined && emitted >= rule.count) break;
    const startMs = addDaysPreservingWallClock(opts.startMs, dayOffset, opts.timeZone);
    if (rule.untilMs !== undefined && startMs > rule.untilMs) break;
    emitted++;
    // Past the window: every later occurrence is too, so stop.
    if (startMs >= opts.windowEndMs) break;
    if (exdates.has(startMs)) continue;
    const occurrence: Occurrence = { startMs, endMs: startMs + duration, originalStartMs: startMs };
    if (overlaps(occurrence, opts.windowStartMs, opts.windowEndMs)) out.push(occurrence);
  }

  return out;
}

function overlaps(o: Occurrence, windowStartMs: number, windowEndMs: number): boolean {
  // Zero-length events (Google allows them) still count if they sit in the window.
  if (o.startMs === o.endMs) return o.startMs >= windowStartMs && o.startMs < windowEndMs;
  return o.endMs > windowStartMs && o.startMs < windowEndMs;
}

/** Day offsets from the master start, in chronological order. */
function* dayOffsets(
  rule: ParsedRrule,
  startMs: number,
  timeZone: string,
  limit: number,
): Generator<number> {
  if (rule.freq === "DAILY") {
    for (let i = 0; i < limit; i++) yield i * rule.interval;
    return;
  }
  const startWeekday = weekdayIn(startMs, timeZone);
  const byDay = rule.byDay.length ? rule.byDay : [startWeekday];
  const posOf = (d: WeekdayCode): number =>
    (WEEKDAY_INDEX[d] - WEEKDAY_INDEX[rule.wkst] + 7) % 7;
  const startPos = posOf(startWeekday);
  const positions = [...new Set(byDay.map(posOf))].sort((a, b) => a - b);

  let produced = 0;
  for (let week = 0; produced < limit; week += rule.interval) {
    for (const pos of positions) {
      const offset = week * 7 + (pos - startPos);
      // Days earlier in the master's own week are before DTSTART — skip them.
      if (offset < 0) continue;
      yield offset;
      if (++produced >= limit) break;
    }
  }
}

export interface ExpandedRow {
  row: EventRow;
  startMs: number;
  endMs: number;
  /** Null for a plain (non-recurring) event. */
  instanceId: string | null;
  originalStartMs: number;
}

/**
 * Expand stored rows into the concrete occurrences overlapping a window,
 * sorted by start. Non-recurring rows pass through unchanged; this is the one
 * path both events.list?singleEvents=true and freeBusy go through, so they can
 * never disagree about when something happens.
 */
export function expandEventRows(
  rows: EventRow[],
  windowStartMs: number,
  windowEndMs: number,
  calendarTimeZone: string,
): ExpandedRow[] {
  const out: ExpandedRow[] = [];
  for (const row of rows) {
    const recurrence = row.recurrence_json
      ? (JSON.parse(row.recurrence_json) as string[])
      : null;
    const timeZone = row.start_tz ?? calendarTimeZone;
    if (!recurrence || !recurrence.length) {
      out.push({
        row,
        startMs: row.start_ms,
        endMs: row.end_ms,
        instanceId: null,
        originalStartMs: row.start_ms,
      });
      continue;
    }
    const occurrences = expandRecurrence({
      startMs: row.start_ms,
      endMs: row.end_ms,
      allDay: row.all_day === 1,
      timeZone,
      recurrence,
      windowStartMs,
      windowEndMs,
    });
    for (const o of occurrences) {
      out.push({
        row,
        startMs: o.startMs,
        endMs: o.endMs,
        instanceId: instanceId(row.id, o.originalStartMs, row.all_day === 1),
        originalStartMs: o.originalStartMs,
      });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || a.row.id.localeCompare(b.row.id));
  return out;
}
