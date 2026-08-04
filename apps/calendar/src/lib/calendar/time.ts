// RFC3339 ⇄ epoch-ms, IANA-zone aware. Everything in the DB is epoch ms; the
// zone is carried alongside so reads can rebuild the exact offset string Google
// returns ("2026-07-28T09:00:00-04:00"), not a UTC-normalised one. Agents diff
// these strings, so the offset has to be right.

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Intl.DateTimeFormat construction is expensive and a window scan calls this
// once per event bound — cache one formatter per zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // Unknown zone: routes validate and 400 before reaching here, so anything
    // that slips through (bad seed data) degrades to UTC rather than throwing
    // mid-response.
    fmt = zoneFormatter("UTC");
  }
  formatterCache.set(timeZone, fmt);
  return fmt;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at that instant. */
export function wallTimeIn(ms: number, timeZone: string): WallTime {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // ICU can render midnight as hour 24 under some locales; normalise to 0.
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Minutes east of UTC for `timeZone` at that instant (−240 for EDT). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const w = wallTimeIn(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Discard sub-second so the difference is a whole number of minutes.
  return (asUtc - Math.floor(ms / 1000) * 1000) / 60_000;
}

/**
 * Interpret a wall-clock reading as an instant in `timeZone`. Two passes: the
 * first guesses with the offset at the naive UTC instant, the second re-reads
 * the offset at that guess so DST transitions land on the correct side.
 */
export function zonedWallTimeToMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - tzOffsetMinutes(naive, timeZone) * 60_000;
  return naive - tzOffsetMinutes(first, timeZone) * 60_000;
}

/** `2026-07-28T09:00:00-04:00`, or `…Z` when the offset is zero. */
export function formatRfc3339(ms: number, timeZone: string): string {
  const offset = tzOffsetMinutes(ms, timeZone);
  const w = wallTimeIn(ms, timeZone);
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp =
    `${p(w.year, 4)}-${p(w.month)}-${p(w.day)}` +
    `T${p(w.hour)}:${p(w.minute)}:${p(w.second)}`;
  if (offset === 0) return `${stamp}Z`;
  const abs = Math.abs(offset);
  return `${stamp}${offset > 0 ? "+" : "-"}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** `2026-07-28` from an all-day bound (stored as UTC midnight). */
export function formatDateOnly(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Parse an RFC3339 timestamp or a bare date. A timestamp with no offset is a
 * floating local time and is resolved in `defaultTimeZone` (Google requires the
 * offset, but SDK users and hand-written agents leave it off constantly).
 * Returns null when the text isn't a timestamp at all.
 */
export function parseRfc3339(text: string, defaultTimeZone = "UTC"): number | null {
  const trimmed = text.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const m = RFC3339.exec(trimmed);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zulu, sign, offH, offM] = m;
  const second = s ? Number(s) : 0;
  if (zulu) return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), second);
  if (sign) {
    const offset = (Number(offH) * 60 + Number(offM)) * (sign === "-" ? -1 : 1);
    return (
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), second) -
      offset * 60_000
    );
  }
  return zonedWallTimeToMs(
    Number(y),
    Number(mo),
    Number(d),
    Number(h),
    Number(mi),
    second,
    defaultTimeZone,
  );
}

/** iCalendar basic format (`20260728T130000Z`, `20260728`) → epoch ms. */
export function parseIcalDate(text: string, defaultTimeZone = "UTC"): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zulu] = m;
  if (!h) return Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (zulu) return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return zonedWallTimeToMs(
    Number(y),
    Number(mo),
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    defaultTimeZone,
  );
}

/**
 * Shift by whole days while holding the wall clock. Across a DST boundary this
 * is 23 or 25 hours of real time — which is what a calendar user means by
 * "same time tomorrow", and what Google's recurrence does.
 */
export function addDaysPreservingWallClock(ms: number, days: number, timeZone: string): number {
  const w = wallTimeIn(ms, timeZone);
  return zonedWallTimeToMs(w.year, w.month, w.day + days, w.hour, w.minute, w.second, timeZone);
}

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

/** Two-letter iCalendar weekday of that instant in `timeZone`. */
export function weekdayIn(ms: number, timeZone: string): WeekdayCode {
  const w = wallTimeIn(ms, timeZone);
  const index = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  return WEEKDAY_CODES[index];
}
