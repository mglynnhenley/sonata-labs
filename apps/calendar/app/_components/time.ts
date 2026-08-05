// Zone-aware wall-clock math via Intl — the grid renders in the calendar's
// stored time_zone, which is generally not the browser's zone, so every
// day-boundary and label computation goes through these helpers.

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday (Google Calendar's default week start). */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function wallParts(ms: number, timeZone: string): WallParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(ms)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl reports midnight as "24" in hour12:false mode.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday ?? "Sun"] ?? 0,
  };
}

/** Epoch ms of a wall-clock time in a zone. Two correction passes handle DST. */
export function epochFromWall(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(ts, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ts += target - asUtc;
  }
  return ts;
}

export interface DayInfo {
  startMs: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/** The 7 day boundaries (plus geometry inputs) of the week containing `ms`. */
export function weekDays(ms: number, timeZone: string): DayInfo[] {
  const p = wallParts(ms, timeZone);
  // Walk dates in UTC space (where day arithmetic is safe), then convert each
  // wall date back to a zone-correct epoch.
  const base = Date.UTC(p.year, p.month - 1, p.day - p.weekday);
  const days: DayInfo[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base + i * 86_400_000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    days.push({
      startMs: epochFromWall(timeZone, year, month, day),
      year,
      month,
      day,
      weekday: i,
    });
  }
  return days;
}

/** Minutes past the day's midnight on the 24-row grid (wall clock, not elapsed). */
export function minutesIntoDay(ms: number, timeZone: string): number {
  const p = wallParts(ms, timeZone);
  return p.hour * 60 + p.minute;
}

export function sameWallDay(a: WallParts, b: WallParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** "GMT-07" / "GMT+05:30" — the gutter label Google Calendar shows. */
export function gmtLabel(ms: number, timeZone: string): string {
  const p = wallParts(ms, timeZone);
  const offsetMin = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms) / 60_000,
  );
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = abs % 60;
  return `GMT${sign}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

/** Header title: "August 2026", or "Aug – Sep 2026" when the week straddles. */
export function weekTitle(days: DayInfo[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  if (first.month === last.month) return `${monthName(first.month)} ${first.year}`;
  const a = monthName(first.month).slice(0, 3);
  const b = monthName(last.month).slice(0, 3);
  if (first.year === last.year) return `${a} – ${b} ${first.year}`;
  return `${a} ${first.year} – ${b} ${last.year}`;
}

/** "1 PM", "1:30 PM" — Google drops :00. */
export function clockLabel(ms: number, timeZone: string): string {
  const p = wallParts(ms, timeZone);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  return p.minute ? `${h12}:${String(p.minute).padStart(2, "0")} ${ampm}` : `${h12} ${ampm}`;
}

export function hourLabel(hour: number): string {
  if (hour === 0) return "";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}
