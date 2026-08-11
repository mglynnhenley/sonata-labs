import { allTwinApiUrls, type TwinName } from "@sonata/core";

// Where the three clones live. Each twin is its own Next app on its own port —
// the dashboard is the control room, the twins are the world — so every deep
// link in a run timeline is built from here. Ports and env precedence come from
// @sonata/core so every consumer resolves a twin to the same place.

export const TWIN_URLS: Record<TwinName, string> = allTwinApiUrls(process.env);

export function twinUrls(twins: readonly TwinName[]): Array<{ twin: TwinName; url: string }> {
  return twins.map((twin) => ({ twin, url: TWIN_URLS[twin] }));
}
