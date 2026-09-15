import { allTwinApiUrls, hasUiService, resolveTwinUiUrl, type TwinName } from "@sonata/core";

// Where the three clones live. Each twin is its own Next app on its own port —
// the dashboard is the control room, the twins are the world — so every deep
// link in a run timeline is built from here. Ports and env precedence come from
// @sonata/core so every consumer resolves a twin to the same place.

export const TWIN_URLS: Record<TwinName, string> = allTwinApiUrls(process.env);

/**
 * Where to send a PERSON who wants to look at a twin: its web UI when it ships
 * one, its API otherwise.
 *
 * Deliberately separate from `TWIN_URLS`, which is where an AGENT connects. The
 * two are different addresses for gmail (3101 is the provider API, 3901 is the
 * mailbox), and sending a human to the API lands them on a JSON service with no
 * inbox in it — which is exactly the wrong door, and reads as a broken link.
 */
export function twinHumanUrl(twin: TwinName): string {
  return hasUiService(twin) ? resolveTwinUiUrl(twin, process.env) : TWIN_URLS[twin];
}

/** Human-facing links — "watch it happen in the apps". See `twinHumanUrl`. */
export function twinUrls(twins: readonly TwinName[]): Array<{ twin: TwinName; url: string }> {
  return twins.map((twin) => ({ twin, url: twinHumanUrl(twin) }));
}
