import type { Clock } from "./types/episode";

// Simulated time. Every date in an episode is derived from the clock, never from
// `Date.now()` — that is what makes two runs of the same spec comparable, and it
// is also the bug the Gmail generator kept hitting (probes claiming "as I
// mentioned yesterday" on a three-month-old thread).

const MS_PER_MINUTE = 60_000;

/** `Z`, `+01:00` or `-0430` at the end of an ISO string. */
const OFFSET = /(?:Z|([+-])(\d{2}):?(\d{2}))$/;

/**
 * Minutes east of UTC declared by the string's own suffix.
 *
 * Throws when there is none. A naive string like "2026-08-04T09:00:00" is parsed
 * in the host machine's zone, so the same spec would produce a different workday
 * on a different laptop — a spec-authoring mistake worth failing loudly on rather
 * than silently guessing UTC.
 */
export function offsetMinutes(iso: string): number {
  const m = OFFSET.exec(iso);
  if (!m) {
    throw new RangeError(
      `ISO time "${iso}" has no UTC offset; write "…Z" or "…+01:00" so the day is the same everywhere`,
    );
  }
  if (!m[1]) return 0;
  const magnitude = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -magnitude : magnitude;
}

function startMs(clock: Clock): number {
  const ms = Date.parse(clock.startISO);
  if (Number.isNaN(ms)) throw new RangeError(`clock.startISO is not a date: "${clock.startISO}"`);
  // Parse the offset too, so an offsetless start fails here rather than later in
  // `tickLabel`, where the failure would look like a formatting bug.
  offsetMinutes(clock.startISO);
  if (!(clock.simMinutesPerTick > 0)) {
    throw new RangeError(`clock.simMinutesPerTick must be positive, got ${clock.simMinutesPerTick}`);
  }
  return ms;
}

/**
 * Absolute instant at the start of `tick`, as UTC ISO. Ticks past the end of the
 * day are allowed: the engine routinely computes `tick + replyDelayTicks` and
 * then checks whether it still fits.
 */
export function tickToISO(clock: Clock, tick: number): string {
  if (!Number.isFinite(tick)) throw new RangeError(`tick must be finite, got ${tick}`);
  return new Date(startMs(clock) + tick * clock.simMinutesPerTick * MS_PER_MINUTE).toISOString();
}

/**
 * Which tick an instant falls in — floored, so anything inside a tick's window
 * belongs to that tick. Negative for instants before the day began; the caller
 * decides whether that means "already happened" or "invalid".
 */
export function isoToTick(clock: Clock, iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`not a date: "${iso}"`);
  return Math.floor((ms - startMs(clock)) / (clock.simMinutesPerTick * MS_PER_MINUTE));
}

/** Last valid tick index. -1 for a zero-tick clock, which is a degenerate spec. */
export function lastTick(clock: Clock): number {
  return clock.ticks - 1;
}

/** Instant the day ends — one tick past the last one, i.e. exclusive. */
export function endISO(clock: Clock): string {
  return tickToISO(clock, clock.ticks);
}

/** `[0, 1, … ticks-1]`, for driving the loop and rendering the timeline axis. */
export function tickRange(clock: Clock): number[] {
  return Array.from({ length: Math.max(0, clock.ticks) }, (_, i) => i);
}

/**
 * Wall-clock label as the company would read it, e.g. "09:15". Rendered in the
 * offset the spec's own `startISO` declares, so a New York episode shows New York
 * times whatever machine it runs on.
 */
export function tickLabel(clock: Clock, tick: number): string {
  const local = Date.parse(tickToISO(clock, tick)) + offsetMinutes(clock.startISO) * MS_PER_MINUTE;
  const shifted = new Date(local);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
