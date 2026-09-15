// Product analytics: what the dashboard reports about itself, and when.
//
// Off by default. Tracking exists only when NEXT_PUBLIC_POSTHOG_KEY is set, so a
// clone of the repo, a CI run and a test never phone home. Everything in this
// module is pure so it can be tested in Node; the PostHog client lives in
// ./track (browser only) and instrumentation-client.ts (the bootstrap).
//
// What is sent is deliberately narrow: which screens are used and where the
// product loop stalls — previewing a scenario, saving it, starting a run,
// reading the report. Never the OpenRouter key, never a scenario brief, never a
// message body. `sanitize` is the last line of that defence and the tests hold
// it to it.

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** A key PostHog itself would reject, and the shape the .env template ships. */
const PLACEHOLDER_KEY = /^phc_(\.\.\.|x+|your|<)/i;

export interface AnalyticsConfig {
  enabled: boolean;
  key: string;
  host: string;
  /** Why tracking is off, for `sonata doctor`-style diagnostics; empty when on. */
  reason: string;
}

export type AnalyticsEnv = Partial<
  Record<"NEXT_PUBLIC_POSTHOG_KEY" | "NEXT_PUBLIC_POSTHOG_HOST" | "NODE_ENV", string | undefined>
>;

/**
 * Decide whether to track and where to send it. Takes the three variables by
 * name rather than `process.env` because Next inlines NEXT_PUBLIC_* into the
 * browser bundle only where each is read as a literal property.
 */
export function analyticsConfig(env: AnalyticsEnv): AnalyticsConfig {
  const key = (env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim();
  const host = normaliseHost(env.NEXT_PUBLIC_POSTHOG_HOST);
  if (env.NODE_ENV === "test") return { enabled: false, key: "", host, reason: "tests never track" };
  if (!key) return { enabled: false, key: "", host, reason: "NEXT_PUBLIC_POSTHOG_KEY is not set" };
  if (PLACEHOLDER_KEY.test(key)) {
    return { enabled: false, key: "", host, reason: "NEXT_PUBLIC_POSTHOG_KEY is the template placeholder" };
  }
  return { enabled: true, key, host, reason: "" };
}

function normaliseHost(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_POSTHOG_HOST;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_POSTHOG_HOST;
    return value;
  } catch {
    return DEFAULT_POSTHOG_HOST;
  }
}

/**
 * The events the dashboard sends, and the properties each carries. A new event
 * is added here first so the name and its shape are reviewable in one place.
 * Properties are counts, ids and enums — nothing a person typed.
 */
export interface AnalyticsEvents {
  /** The composer asked the model for a scenario draft. */
  scenario_previewed: { ticks: number; input_chars: number; with_expectations: boolean; ok: boolean };
  /** A previewed draft became a saved scenario. */
  scenario_saved: { episode_id: string; ticks: number };
  /** A shipped example day was opened as a scenario. */
  scenario_from_template: { template_id: string };
  /** The dashboard asked the engine to play a day. */
  run_started: { episode_id: string; model: string; twins: readonly string[]; ticks: number };
  /** The run report was opened. Fired once per page load. */
  report_viewed: { run_id: string; status: string; outcome: string | null };
  /** Settings were saved; only which fields, never their values. */
  settings_saved: { fields: readonly string[] };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/** Property names that must never leave the machine, whatever event they ride on. */
const FORBIDDEN = /key|token|secret|password|brief|body|text|email/i;
const MAX_STRING = 200;

/**
 * Strip anything that looks like a credential or free text, and cap strings.
 * Applied to every event at the point of sending, not trusted to call sites.
 */
export function sanitize(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (FORBIDDEN.test(name)) continue;
    if (typeof value === "string") out[name] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[name] = value;
    else if (Array.isArray(value)) out[name] = value.filter((v) => typeof v === "string" || typeof v === "number").slice(0, 20);
    // Objects are dropped: a nested payload is how a whole request body leaks.
  }
  return out;
}
