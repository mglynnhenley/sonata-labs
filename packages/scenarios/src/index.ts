import type { EpisodeSpec } from "@sonata/core";
import { candidateScheduling } from "./candidateScheduling";
import { clientEscalation } from "./clientEscalation";
import { invoiceChase } from "./invoiceChase";
import { meridianExcursion } from "./meridianExcursion";
import { outageComms } from "./outageComms";
import { travelDay } from "./travelDay";
import { vcInvestmentDay } from "./vcInvestmentDay";
import { vcCopilotDay } from "./vcCopilotDay";
import { taxWorkbookDay } from "./taxWorkbookDay";
import { taxReportingDay } from "./taxReportingDay";
import { vcBusyDay } from "./vcBusyDay";

// @sonata/scenarios — hand-written days, including explicitly labelled research pilots.
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
  meridianExcursion,
  vcInvestmentDay,
  vcBusyDay,
  vcCopilotDay,
  taxReportingDay,
  taxWorkbookDay,
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

export {
  candidateScheduling,
  clientEscalation,
  invoiceChase,
  meridianExcursion,
  outageComms,
  travelDay,
  vcInvestmentDay,
};
export { VC_FUND } from "./vcInvestmentDay";
export { vcBusyDay, VC_BUSY_WORLD, VC_BUSY_MEETINGS } from "./vcBusyDay";
export { SIM_MINUTES_PER_TICK, WORKDAY_TICKS, workday, type Workday } from "./day";
export { AMBROSE_HALE, HALFMOON, MERIDIAN, NORTHWIND, TESSERA } from "./worlds";

export { vcCopilotDay, VC_COPILOT_WORLD, VC_CALLS } from "./vcCopilotDay";

export { taxReportingDay, TAX_WORLD, TAX_PRIOR, TAX_CURRENT } from "./taxReportingDay";

export { taxWorkbookDay, TAX_WORKBOOK_WORLD, TAX_WORKBOOK_MEETINGS } from "./taxWorkbookDay";
