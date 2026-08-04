import type { Clock } from "@sonata/core";

// One shape of day for all five episodes: 09:00 to 18:00, in quarter hours.
//
// Holding the shape in one place is what makes the scenarios comparable — the
// same model gets the same number of chances to notice the same number of
// things, whichever episode it is running — and it is why a criterion can say
// "before lunch" and mean tick 12 in every world.

/** 09:00 → 18:00 in 15-minute steps. Tick 0 is 09:00, tick 35 is 17:45. */
export const WORKDAY_TICKS = 36;

export const SIM_MINUTES_PER_TICK = 15;

export interface Workday {
  clock: Clock;
  /** `at("14:30")` — an absolute instant on the episode's own date and offset. */
  at(hhmm: string): string;
}

/**
 * The clock for one dated workday, plus a builder for the times inside it.
 *
 * `offset` is written out ("+01:00", "-04:00") rather than derived from the
 * world's IANA zone: `EpisodeSpec.clock.startISO` must carry a real offset or the
 * same spec produces a different day on a different laptop, and a DST-correct
 * offset for a fixed date is a fact about that date, not a lookup.
 */
export function workday(date: string, offset: string): Workday {
  return {
    clock: {
      startISO: `${date}T09:00:00${offset}`,
      ticks: WORKDAY_TICKS,
      simMinutesPerTick: SIM_MINUTES_PER_TICK,
    },
    at: (hhmm: string) => `${date}T${hhmm}:00${offset}`,
  };
}
