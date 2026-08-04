import type { ByTwin, TwinName } from "@sonata/core";
import type { TwinHttp } from "../http";
import { gmailTools } from "./gmail";
import { slackTools } from "./slack";
import { calendarTools } from "./calendar";
import type { EngineTool } from "./types";

export * from "./types";
export { gmailTools } from "./gmail";
export { slackTools } from "./slack";
export { calendarTools, freeWindows } from "./calendar";

/**
 * The toolset for the twins an episode actually uses.
 *
 * Only those twins: a tool the day has no use for is a tool the agent can waste
 * a turn on, and — more to the point — an agent handed calendar tools in a
 * mailbox-only episode that never touches them looks identical to one that had
 * them and chose well.
 */
export function toolsFor(twins: TwinName[], http: ByTwin<TwinHttp>): EngineTool[] {
  const out: EngineTool[] = [];
  for (const twin of twins) {
    const client = http[twin];
    if (!client) continue;
    if (twin === "gmail") out.push(...gmailTools(client));
    if (twin === "slack") out.push(...slackTools(client));
    if (twin === "calendar") out.push(...calendarTools(client));
  }
  return out;
}
