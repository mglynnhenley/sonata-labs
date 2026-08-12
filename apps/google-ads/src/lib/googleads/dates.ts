// Dates in this clone are `YYYY-MM-DD` strings in the account's own time zone,
// because that is exactly how they cross the wire and how daily_stats is keyed.
// Everything a report needs is arithmetic on those strings, so the epoch-ms form
// only ever appears at the one boundary — turning `world_now_ms` into today.

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // Seeds validate the zone at the door, so anything that reaches here is a
    // hand-edited database — degrade to UTC rather than throw mid-response.
    fmt = zoneFormatter("UTC");
  }
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/** The account's local calendar date at that instant. `en-CA` renders YYYY-MM-DD. */
export function formatInZone(ms: number, timeZone: string): string {
  return zoneFormatter(timeZone).format(new Date(ms));
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar arithmetic on the date string, via UTC so no zone can shift the day. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** First and last day of the month `date` falls in, inclusive. */
export function monthBounds(date: string): { start: string; end: string } {
  const [y, m] = date.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
