// The continuity desk domains: what a critical-infrastructure desk knows, what
// it is allowed to do, and how a week's work is assessed afterwards.
//
// This is a package rather than part of the engine because two very different
// processes need the same rules. The engine runs them in-process for a
// deterministic reference route; the desk twin serves them over HTTP to an agent
// working inside its own container. Neither can be the other's owner, and a
// second copy of a rule about superseded evidence is a benchmark that quietly
// scores two different weeks.
//
// Nothing here knows about agents, ticks or the engine's clock. A domain is told
// the simulated instant; it never decides one.
export type * from "./types";
export { SqliteDeskStore } from "./store";
export { waterCase, waterDomain } from "./water";
export { electricityCase, electricityDomain } from "./electricity";

import { waterCase } from "./water";
import { electricityCase } from "./electricity";
import type { DeskCase } from "./types";

export const CONTINUITY_CASES: readonly DeskCase[] = [waterCase, electricityCase];

/** By scenario id or case id — callers hold one or the other. */
export function continuityCase(id: string): DeskCase | undefined {
  return CONTINUITY_CASES.find((desk) => desk.spec.id === id || desk.domain.id === id);
}
