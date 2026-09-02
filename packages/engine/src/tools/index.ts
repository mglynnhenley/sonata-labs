import type { ByTwin, TwinName } from "@sonata/core";
import type { TwinHttp } from "../http";
import { attioTools } from "./attio";
import { gmailTools } from "./gmail";
import { googleDocsTools } from "./google-docs";
import { slackTools } from "./slack";
import { calendarTools } from "./calendar";
import type { EngineTool } from "./types";

export * from "./types";
export { gmailTools } from "./gmail";
export { slackTools } from "./slack";
export { calendarTools, freeWindows } from "./calendar";
export { attioTools } from "./attio";
export { googleDocsTools } from "./google-docs";
export {
  createOpenItems,
  describeOpenItems,
  renderOpenItems,
  OPEN_ITEMS_TOOL,
  type OpenItem,
  type OpenItems,
  type OpenItemsCall,
} from "./openItems";

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
    out.push(...toolsForTwin(twin, client));
  }
  return out;
}

/**
 * One twin's toolset. A switch rather than a lookup table so that a twin added
 * to `TwinName` and forgotten here fails to compile — the alternative is an
 * agent handed an empty toolbox for a surface its day is about, which looks
 * exactly like an agent that chose not to use it.
 */
function toolsForTwin(twin: TwinName, http: TwinHttp): EngineTool[] {
  switch (twin) {
    case "gmail":
      return gmailTools(http);
    case "slack":
      return slackTools(http);
    case "calendar":
      return calendarTools(http);
    case "attio":
      return attioTools(http);
    case "google-docs":
      return googleDocsTools(http);
  }
}
