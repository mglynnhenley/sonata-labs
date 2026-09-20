// Next runs this once in the browser before the app hydrates. It is the only
// place PostHog is initialised; see src/lib/analytics.ts for what is sent and
// why, and src/lib/track.ts for how components send it.
import posthog from "posthog-js";
import { analyticsConfig } from "@/lib/analytics";
import { markAnalyticsReady } from "@/lib/track";

// Each variable is read as a literal property so Next inlines it at build time.
const config = analyticsConfig({
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NODE_ENV: process.env.NODE_ENV,
});

if (config.enabled) {
  posthog.init(config.key, {
    api_host: config.host,
    // The app router navigates without full loads; this captures each one.
    capture_pageview: "history_change",
    capture_pageleave: true,
    // Clicks on buttons and links, with element text masked: a scenario title
    // or a colleague's name in a button label is not ours to collect.
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    // No replays: the Settings screen holds an API key, and a run report holds
    // a business's simulated inbox.
    disable_session_recording: true,
    // Anonymous by default; nothing here calls identify().
    person_profiles: "identified_only",
    respect_dnt: true,
    loaded: () => markAnalyticsReady(),
  });
}
