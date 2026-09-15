import posthog from "posthog-js";
import { sanitize, type AnalyticsEventName, type AnalyticsEvents } from "./analytics";

// The browser half of analytics. `track` is safe to call from any client
// component at any time: before PostHog has loaded, when it is disabled, or on
// the server during prerender, it does nothing. instrumentation-client.ts flips
// `ready` once init has actually completed, so a call never queues into a client
// that was never configured.

let ready = false;

/** Called by instrumentation-client.ts from PostHog's `loaded` callback. */
export function markAnalyticsReady(): void {
  ready = true;
}

export function analyticsReady(): boolean {
  return ready;
}

export function track<E extends AnalyticsEventName>(event: E, props: AnalyticsEvents[E]): void {
  if (!ready || typeof window === "undefined") return;
  try {
    posthog.capture(event, sanitize(props as Record<string, unknown>));
  } catch {
    // Analytics must never take the product down with it.
  }
}
