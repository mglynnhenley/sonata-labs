import type { ByTwin, TwinAdapter, TwinName } from "@sonata/core";
import { createCalendarAdapter, type CalendarAdapterOptions } from "./calendar";
import { createGmailAdapter, type GmailAdapterOptions } from "./gmail";
import { createSlackAdapter, type SlackAdapterOptions } from "./slack";

export * from "./gmail";
export * from "./slack";
export * from "./calendar";
export { normalizeAudit } from "./shared";

export interface AdapterSetOptions {
  gmail?: GmailAdapterOptions;
  slack?: SlackAdapterOptions;
  calendar?: CalendarAdapterOptions;
}

/**
 * All three adapters, pointed at the local twins. The engine only ever uses the
 * ones an episode's beats and criteria actually need (`episodeTwins`), so
 * building all three is free — nothing connects until something is asked of it.
 */
export function createAdapters(opts: AdapterSetOptions = {}): TwinAdapter[] {
  return [
    createGmailAdapter(opts.gmail),
    createSlackAdapter(opts.slack),
    createCalendarAdapter(opts.calendar),
  ];
}

/** Index adapters by name, so the tick loop can route a beat in one lookup. */
export function byTwin(adapters: TwinAdapter[]): ByTwin<TwinAdapter> {
  const map: ByTwin<TwinAdapter> = {};
  for (const a of adapters) map[a.name] = a;
  return map;
}

export function adapterNames(adapters: TwinAdapter[]): TwinName[] {
  return adapters.map((a) => a.name);
}
