import type { EpisodeSpec } from "@sonata/core";
import { candidateScheduling } from "./candidateScheduling";
import { clientEscalation } from "./clientEscalation";
import { invoiceChase } from "./invoiceChase";
import { outageComms } from "./outageComms";
import { travelDay } from "./travelDay";

// @sonata/scenarios — the five hand-written days the benchmark runs on.
//
// Every one of them is a full simulated workday (09:00–18:00, 36 ticks) in a
// company that already exists, and none of them can be solved by reading one
// message: the fact that decides the day always lives on a different surface
// from the thing that asks for it. Chasing the invoice needs a Slack thread, the
// client's reply needs the calendar, the interview loop needs all three.
//
// Pure data, no I/O, no model client — importing this package costs nothing, and
// a spec can be written to disk, diffed against last month's, and replayed on a
// different model unchanged.

export const SCENARIOS: readonly EpisodeSpec[] = [
  clientEscalation,
  invoiceChase,
  candidateScheduling,
  outageComms,
  travelDay,
];

/**
 * One scenario by id, or undefined for an unknown one — mirrors `templateById`
 * in @sonata/world. Callers decide whether a missing scenario is a typo worth
 * failing on or a filter that simply matched nothing.
 */
export function getScenario(id: string): EpisodeSpec | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Every scenario id, in run order. The default suite for the benchmark. */
export function scenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}

export { candidateScheduling, clientEscalation, invoiceChase, outageComms, travelDay };
export { SIM_MINUTES_PER_TICK, WORKDAY_TICKS, workday, type Workday } from "./day";
export { AMBROSE_HALE, HALFMOON, NORTHWIND, TESSERA } from "./worlds";
