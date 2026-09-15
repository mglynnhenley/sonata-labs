import type { EpisodeSpec } from '@sonata/core';

export interface DeskRecord { id: string; kind: string; data: Record<string, unknown> }
export interface DeskEvent { id: number; at: string; actor: 'agent' | 'world'; kind: string; data: Record<string, unknown> }
export interface DeskUnit { id: string; score: 0 | 1 | 2 | 'U' | 'N/A'; evidence: string[]; reason: string }
export interface DeskCriterion { id: string; family: string; group?: string; units: DeskUnit[]; reporting?: boolean }
export interface DeskAssessment { criteria: DeskCriterion[]; incidents: Array<Record<string, unknown>>; limitations: string[] }
/** Domain code receives only this persisted store. All state, including pending jobs, belongs here. */
export interface DeskStore {
  get<T = Record<string, unknown>>(id: string): T | undefined;
  put(id: string, data: unknown): void;
  list(prefix?: string): Array<{ id: string; data: Record<string, unknown> }>;
  event(at: string, actor: 'agent' | 'world', kind: string, data: Record<string, unknown>): number;
  events(): DeskEvent[];
}
export interface DeskTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutation: boolean;
}
export interface DeskDomain {
  id: "W01" | "E01";
  tools: DeskTool[];
  seed(store: DeskStore): void;
  /** Release fixed facts/replies before agent; execute scheduled dispatches after agent. Preserve actual timestamps. */
  advance(store: DeskStore, at: string, phase: 'before' | 'after'): void;
  execute(store: DeskStore, tool: string, args: Record<string, unknown>, at: string): unknown;
  assess(store: DeskStore, completedThrough: string | null): DeskAssessment;
}
export interface ReferenceAction { tick: number; tool: string; args: Record<string, unknown> }
export interface DeskCase {
  spec: EpisodeSpec;
  domain: DeskDomain;
  /** Successful authored route, plus concrete late/preventive/alternative variants. Never given to the model. */
  routes: Record<string, ReferenceAction[]>;
}
