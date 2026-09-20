import { describe, expect, it } from "vitest";
import { DEFAULT_POSTHOG_HOST, analyticsConfig, sanitize, type AnalyticsEvents } from "@/lib/analytics";

// Tracking is off unless someone chose it, and what it sends is narrow. Both
// are promises to whoever runs this on their own machine, so both are tests.

describe("analyticsConfig", () => {
  it("is off with no key, and says why", () => {
    const config = analyticsConfig({});
    expect(config.enabled).toBe(false);
    expect(config.key).toBe("");
    expect(config.reason).toMatch(/not set/);
  });

  it("is off when the key is blank or the template placeholder", () => {
    expect(analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "   " }).enabled).toBe(false);
    expect(analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "phc_..." }).enabled).toBe(false);
    expect(analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "phc_xxxxxxxx" }).enabled).toBe(false);
  });

  it("never tracks under test, even with a real-looking key", () => {
    const config = analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "phc_abc123def456", NODE_ENV: "test" });
    expect(config.enabled).toBe(false);
    expect(config.reason).toMatch(/tests/);
  });

  it("is on with a key, trimmed, and defaults the host", () => {
    const config = analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: " phc_abc123def456 ", NODE_ENV: "production" });
    expect(config).toEqual({ enabled: true, key: "phc_abc123def456", host: DEFAULT_POSTHOG_HOST, reason: "" });
  });

  it("accepts an http(s) host override and strips a trailing slash", () => {
    const config = analyticsConfig({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_abc123def456",
      NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com/",
    });
    expect(config.host).toBe("https://eu.i.posthog.com");
  });

  it("falls back to the default host when the override is not a URL", () => {
    for (const bad of ["eu.i.posthog.com", "ftp://x", "not a url", ""]) {
      expect(analyticsConfig({ NEXT_PUBLIC_POSTHOG_KEY: "phc_abc123def456", NEXT_PUBLIC_POSTHOG_HOST: bad }).host).toBe(
        DEFAULT_POSTHOG_HOST,
      );
    }
  });
});

describe("sanitize", () => {
  it("drops anything named like a credential or free text", () => {
    const out = sanitize({
      apiKey: "sk-or-v1-secret",
      openrouter_api_key: "x",
      token: "t",
      SANDBOX_TOKEN: "s",
      password: "p",
      brief: "A post house with one client…",
      body: "Dear Clive",
      text: "hello",
      email: "nadia@harrowlane.com",
      ticks: 24,
    });
    expect(out).toEqual({ ticks: 24 });
  });

  it("keeps scalars and string arrays, drops nested objects", () => {
    const out = sanitize({
      episode_id: "vc-busy-investment-day",
      ok: true,
      outcome: null,
      twins: ["gmail", "slack", 3, { nested: "no" }],
      payload: { request: "whole body" },
    });
    expect(out).toEqual({ episode_id: "vc-busy-investment-day", ok: true, outcome: null, twins: ["gmail", "slack", 3] });
  });

  it("caps long strings and long arrays", () => {
    const out = sanitize({ model: "m".repeat(500), twins: Array.from({ length: 40 }, (_, i) => `t${i}`) });
    expect((out.model as string).length).toBe(201);
    expect((out.twins as unknown[]).length).toBe(20);
  });
});

// Every declared event, with a representative payload. sanitize() filters by
// property NAME, so a badly chosen name (say, brief_chars) would be dropped on
// every send and nobody would notice: the dashboard would report the event with
// a hole in it. This holds the event table and the filter to each other.
const SAMPLES: { [E in keyof AnalyticsEvents]: AnalyticsEvents[E] } = {
  scenario_previewed: { ticks: 24, input_chars: 140, with_expectations: true, ok: true },
  scenario_saved: { episode_id: "ep_123", ticks: 24 },
  scenario_from_template: { template_id: "meridian-excursion" },
  run_started: { episode_id: "ep_123", model: "anthropic/claude-haiku-4.5", twins: ["gmail", "slack"], ticks: 32 },
  report_viewed: { run_id: "run_abc", status: "done", outcome: "pass" },
  settings_saved: { fields: ["models.agent", "apiKey"] },
};

describe("declared events", () => {
  it("survive sanitize with every property intact", () => {
    for (const [event, props] of Object.entries(SAMPLES)) {
      expect(sanitize(props as Record<string, unknown>), event).toEqual(props);
    }
  });
});
