import type { TwinName } from "@sonata/core";

// Where the three clones live. Each twin is its own Next app on its own port —
// the dashboard is the control room, the twins are the world — so every deep
// link in a run timeline is built from here.

export const TWIN_URLS: Record<TwinName, string> = {
  gmail: process.env.SONATA_GMAIL_URL ?? "http://localhost:3101",
  slack: process.env.SONATA_SLACK_URL ?? "http://localhost:3200",
  calendar: process.env.SONATA_CALENDAR_URL ?? "http://localhost:3400",
};

export function twinUrls(twins: readonly TwinName[]): Array<{ twin: TwinName; url: string }> {
  return twins.map((twin) => ({ twin, url: TWIN_URLS[twin] }));
}
