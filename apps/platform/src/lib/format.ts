import { offsetMinutes } from "@sonata/core";

// Formatting shared by server and client components. Pure, and importing only
// @sonata/core, so a "use client" file can pull it in without dragging the
// database along.

const MS_PER_MINUTE = 60_000;

/** Minutes east of UTC declared by the string, or 0. Never the host's zone —
 *  that would make the same run read differently on two machines. */
function shiftOf(iso: string): number {
  try {
    return offsetMinutes(iso);
  } catch {
    return 0;
  }
}

function hhmm(utcMs: number, shiftMinutes: number): string {
  const d = new Date(utcMs + shiftMinutes * MS_PER_MINUTE);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * "09:15" — the simulated clock as the cloned company reads it, rendered in the
 * offset the timestamp itself declares. A run started in a New York world shows
 * New York times on a laptop in London.
 */
export function simClock(iso: string | null): string {
  if (!iso) return "--:--";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "--:--";
  return hhmm(ms, shiftOf(iso));
}

// A value and its unit are one word. These sit in narrow table columns, where an
// ordinary space let "20m 13s" break into "20m" over "13s" and read as two
// numbers — so every gap inside a single measurement is non-breaking.
const NBSP = " ";

/** "just now", "4 min ago", "3 h ago", "12 Mar". */
export function ago(epochMs: number | null, now: number = Date.now()): string {
  if (!epochMs) return "—";
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${NBSP}min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}${NBSP}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}${NBSP}d ago`;
  // The locale is pinned, never `undefined`: that resolves to Node's ICU default
  // on the server and the browser's locale on the client, so the same row renders
  // "12 Mar" in the HTML and "Mar 12" after hydration. en-GB, as everywhere else
  // that formats a date here.
  return new Date(epochMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "4m 12s" — how long a run took in real time. */
export function elapsed(fromMs: number, toMs: number): string {
  const total = Math.max(0, Math.round((toMs - fromMs) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${NBSP}${seconds}s` : `${seconds}s`;
}

/** 0..1 → "84%". Null stays a dash: an unscored run must not read as zero. */
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

/** Spend. Sub-cent figures keep three places, or a whole benchmark reads "$0.00". */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

/** "09:00 → 17:00" for a clock of `ticks` × `simMinutesPerTick` from `startISO`. */
export function dayRange(startISO: string, simMinutesPerTick: number, ticks: number): string {
  const startMs = Date.parse(startISO);
  if (Number.isNaN(startMs)) return "—";
  const shift = shiftOf(startISO);
  return `${hhmm(startMs, shift)} → ${hhmm(startMs + ticks * simMinutesPerTick * MS_PER_MINUTE, shift)}`;
}
