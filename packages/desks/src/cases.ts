// The authored weeks, reachable without a database driver.
//
// Split from the barrel on purpose. The agent's MCP server derives its tool list
// from these domains, and it runs in a container that has no business holding a
// SQLite driver: `index.ts` re-exports `SqliteDeskStore`, so importing the
// barrel would put better-sqlite3 in the agent bundle. The runtime build refuses
// that, which is how this split was found.
import { waterCase } from "./water";
import { electricityCase } from "./electricity";
import type { DeskCase } from "./types";

export const CONTINUITY_CASES: readonly DeskCase[] = [waterCase, electricityCase];

/** By scenario id or case id — callers hold one or the other. */
export function continuityCase(id: string): DeskCase | undefined {
  return CONTINUITY_CASES.find((desk) => desk.spec.id === id || desk.domain.id === id);
}
