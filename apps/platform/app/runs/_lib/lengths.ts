// How long a day runs, as offered by the run panel.
//
// The saved scenario carries a clock, and until now that clock was the run: the
// shortest thing you could start was twelve ticks, about five minutes and half a
// dollar on the cheapest model — several dollars on a frontier one. Nobody
// iterates against a loop that slow, so nobody smoke-tested a change; they
// guessed. The clock is a DEFAULT, not a constraint, and the engine has always
// accepted a per-run override (`specForRun` clamps to 1..200) — this is only the
// list of overrides the panel puts in front of a person.

/** The cheap path. Four ticks is one simulated hour: enough to see the agent
 * open its inbox, pick something up and act, which is what a smoke test is for. */
export const SMOKE_TICKS = 4;

export interface RunLength {
  ticks: number;
  label: string;
  /** Simulated hours, plus what the length is good for. */
  hint: string;
}

/** Fixed offers, shortest first. The scenario's own clock is appended per run. */
export const RUN_LENGTHS: readonly RunLength[] = [
  { ticks: SMOKE_TICKS, label: "Smoke test", hint: "1 hour — did the change work?" },
  { ticks: 12, label: "Short", hint: "3 hours — a morning" },
  { ticks: 24, label: "Half day", hint: "6 hours — 9am to 3pm" },
];

/** Engine limits, mirrored so the panel refuses what `specForRun` would clamp. */
export const MIN_TICKS = 1;
export const MAX_TICKS = 200;

/**
 * The lengths on offer for one scenario: the fixed set, plus the scenario's own
 * clock labelled as the full day. De-duplicated by tick count, because a
 * scenario written as a 24-tick day would otherwise show "Half day" and "Full
 * day" as two buttons that do exactly the same thing.
 */
export function lengthsFor(scenarioTicks: number): RunLength[] {
  const full: RunLength = {
    ticks: scenarioTicks,
    label: "Full day",
    hint: `${scenarioTicks} ticks — the scenario's own clock`,
  };
  const out = RUN_LENGTHS.filter((l) => l.ticks < scenarioTicks);
  return [...out, full];
}

/** True when this length stops the day before the scenario's clock does. */
export function isShortened(ticks: number, scenarioTicks: number): boolean {
  return ticks < scenarioTicks;
}

/** Scripted moments scheduled past the last tick that will run. */
export function beatsCutOff(beatTicks: readonly number[], ticks: number): number {
  return beatTicks.filter((t) => t >= ticks).length;
}
