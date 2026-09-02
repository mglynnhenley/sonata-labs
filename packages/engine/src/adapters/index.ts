import type { ByTwin, TwinAdapter, TwinName } from "@sonata/core";
import { createAttioAdapter, type AttioAdapterOptions } from "./attio";
import { createCalendarAdapter, type CalendarAdapterOptions } from "./calendar";
import { createGmailAdapter, type GmailAdapterOptions } from "./gmail";
import { createGoogleAdsAdapter, type GoogleAdsAdapterOptions } from "./google-ads";
import { createGoogleDocsAdapter, type GoogleDocsAdapterOptions } from "./google-docs";
import { createLinkedInAdapter, type LinkedInAdapterOptions } from "./linkedin";
import { createSlackAdapter, type SlackAdapterOptions } from "./slack";

export * from "./gmail";
export * from "./slack";
export * from "./calendar";
export * from "./attio";
export * from "./google-docs";
export * from "./google-ads";
export * from "./linkedin";
// Only this one, deliberately: `./shared` also exports a `seedBodyFor`, and
// starring it here would collide with the LinkedIn adapter's own.
export { normalizeAudit } from "./shared";

export interface AdapterSetOptions {
  gmail?: GmailAdapterOptions;
  slack?: SlackAdapterOptions;
  calendar?: CalendarAdapterOptions;
  attio?: AttioAdapterOptions;
  "google-docs"?: GoogleDocsAdapterOptions;
  "google-ads"?: GoogleAdsAdapterOptions;
  linkedin?: LinkedInAdapterOptions;
}

/**
 * Every adapter, pointed at the local twins. The engine only ever uses the ones
 * an episode's beats and criteria actually need (`episodeTwins`), so building
 * them all is free — nothing connects until something is asked of it.
 */
export function createAdapters(opts: AdapterSetOptions = {}): TwinAdapter[] {
  return [
    createGmailAdapter(opts.gmail),
    createSlackAdapter(opts.slack),
    createCalendarAdapter(opts.calendar),
    createAttioAdapter(opts.attio),
    createGoogleDocsAdapter(opts["google-docs"]),
    createGoogleAdsAdapter(opts["google-ads"]),
    createLinkedInAdapter(opts.linkedin),
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
