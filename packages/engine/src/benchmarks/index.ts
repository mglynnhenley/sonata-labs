import type { EpisodeSpec } from '@sonata/core';
import { electricityCase } from './electricity';
import { waterCase } from './water';
import { createDeskEnvironment } from './runtime';
export { createDeskEnvironment } from './runtime';
export type { EpisodeEnvironment } from './runtime';
export { SqliteDeskStore } from './store';
export type * from './types';
export const CONTINUITY_CASES = [waterCase, electricityCase] as const;
export function continuityCase(id: string) {
  return CONTINUITY_CASES.find(c => c.spec.id === id || c.domain.id === id);
}
export function createContinuityEnvironment(spec: EpisodeSpec, directory: string) {
  if (!spec.benchmark) return undefined;
  const desk = continuityCase(spec.benchmark.caseId);
  if (!desk || desk.spec.id !== spec.id || spec.benchmark.version !== 1) {
    throw new Error(`Unsupported continuity case/version: ${spec.id}`);
  }
  return createDeskEnvironment({ ...desk, spec }, directory);
}
