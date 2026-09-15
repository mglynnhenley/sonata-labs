import type { EpisodeSpec } from "@sonata/core";
import { continuityCase } from "@sonata/desks";
import { createDeskEnvironment } from "./runtime";

export { createDeskEnvironment } from "./runtime";
export type { EpisodeEnvironment } from "./runtime";
export { createReferenceAgent } from "./reference";
export { CONTINUITY_CASES, continuityCase, SqliteDeskStore } from "@sonata/desks";
export type * from "@sonata/desks";

/**
 * The desk a spec asks for, refusing anything it did not ask for exactly.
 *
 * A spec and a domain are two halves of one authored week: the spec publishes the
 * clock and the brief, the domain holds the rules the assessment is made of.
 * Pairing the wrong halves would produce a week that runs and scores and means
 * nothing, so the case id, the scenario id and the version must all agree.
 */
export function createContinuityEnvironment(spec: EpisodeSpec, directory: string) {
  if (!spec.benchmark) return undefined;
  const desk = continuityCase(spec.benchmark.caseId);
  if (!desk || desk.spec.id !== spec.id || spec.benchmark.version !== 1) {
    throw new Error(`Unsupported continuity case/version: ${spec.id}`);
  }
  return createDeskEnvironment({ ...desk, spec }, directory);
}
