import {
  type Clock,
  endISO,
  isoToTick,
  lastTick,
  tickLabel,
  tickRange,
  tickToISO,
} from "@sonata/core";

// The simulated clock, bound to one episode's `Clock`.
//
// The arithmetic itself lives in @sonata/core (pure functions over an explicit
// `Clock`), because the dashboard and the judge need the same conversions with
// no engine attached. What is added here is the *binding*: every part of the
// tick loop — beats, the director, the agent's "it is 09:15" — reads time from
// one object built once at the top of the run, so nothing downstream can reach
// for `Date.now()` and quietly desynchronise the day.
//
// Wall-clock time still exists in the engine (run duration, budget guards), but
// it never dates anything inside the world. That separation is the whole reason
// two runs of the same spec are comparable.

export interface SimClock {
  /** The spec's own clock, for anything that needs the raw fields. */
  readonly spec: Clock;
  /** How many ticks the day runs for. */
  readonly ticks: number;

  /** Absolute instant at the start of `tick`, as UTC ISO. */
  isoAt(tick: number): string;
  /** Wall-clock label the company would read, e.g. "09:15". */
  labelAt(tick: number): string;
  /** Which tick an instant falls in. Negative before the day began. */
  tickAt(iso: string): number;
  /** True for ticks inside the day. */
  contains(tick: number): boolean;
  /** Last valid tick index. */
  last(): number;
  /** Instant the day ends — one tick past the last, i.e. exclusive. */
  end(): string;
  /** `[0, 1, … ticks-1]`, for driving the loop and the timeline axis. */
  all(): number[];
  /** `[from … to]`, clamped to the day. Empty when the range is inverted. */
  range(from: number, to: number): number[];
  /** Ticks whose start falls in `[fromISO, toISO)`, clamped to the day. */
  between(fromISO: string, toISO: string): number[];
  /** Simulated minutes from the start of `from` to the start of `to`. */
  minutesBetween(from: number, to: number): number;
  /** "09:15–09:30" — the window a tick covers, for timeline headers. */
  windowLabel(tick: number): string;
}

export function createClock(spec: Clock): SimClock {
  // Force the validation in `tickToISO` (offset present, positive tick length)
  // to happen at construction rather than three ticks into a run.
  tickToISO(spec, 0);

  const clock: SimClock = {
    spec,
    ticks: spec.ticks,
    isoAt: (tick) => tickToISO(spec, tick),
    labelAt: (tick) => tickLabel(spec, tick),
    tickAt: (iso) => isoToTick(spec, iso),
    contains: (tick) => Number.isInteger(tick) && tick >= 0 && tick < spec.ticks,
    last: () => lastTick(spec),
    end: () => endISO(spec),
    all: () => tickRange(spec),
    range(from, to) {
      const lo = Math.max(0, Math.ceil(from));
      const hi = Math.min(lastTick(spec), Math.floor(to));
      const out: number[] = [];
      for (let t = lo; t <= hi; t++) out.push(t);
      return out;
    },
    between(fromISO, toISO) {
      // `isoToTick` floors, so an instant partway through a tick belongs to that
      // tick — but a *range* starting partway through it must not re-fire it.
      // Hence ceil on the lower bound and an exclusive upper bound.
      //
      // Compared as instants, never as strings: `tickToISO` always renders UTC
      // with milliseconds, so "09:00:00+01:00" — a perfectly good tick boundary —
      // would fail a string match and silently drop the tick it starts.
      const from = isoToTick(spec, fromISO);
      const to = isoToTick(spec, toISO);
      const startsAt = (tick: number, iso: string): boolean =>
        Date.parse(tickToISO(spec, tick)) === Date.parse(iso);
      const lower = startsAt(from, fromISO) ? from : from + 1;
      const upper = startsAt(to, toISO) ? to - 1 : to;
      return clock.range(lower, upper);
    },
    minutesBetween: (from, to) => (to - from) * spec.simMinutesPerTick,
    windowLabel: (tick) => `${tickLabel(spec, tick)}–${tickLabel(spec, tick + 1)}`,
  };
  return clock;
}
