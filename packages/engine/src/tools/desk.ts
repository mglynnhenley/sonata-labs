import { CONTINUITY_CASES, type DeskTool } from "@sonata/desks";
import type { TwinHttp } from "../http";
import { fn, type EngineTool } from "./types";

// The desk's tools are the only ones in the repo that are not written out here.
//
// Every other twin fronts a product whose API is the same on Tuesday as it was
// on Monday, so its toolset is a literal. A desk's toolset belongs to the week
// being run: W01 submits incident notifications to a water regulator, E01
// commits resources against an electricity outage, and neither should ever see
// the other's verbs. So the list is derived from the authored domain, and the
// case is named per run.
//
// Which case is resolved from the environment rather than passed down, because
// the caller that needs it most is the MCP server: a separate process, started
// inside the run's own container, that is handed URLs and credentials the same
// way. A run without `SONATA_DESK_CASE` is not a desk run, and gets no tools
// rather than a guess.

/** Case id for this run, or undefined when the run has no desk. */
export function deskCaseId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.SONATA_DESK_CASE?.trim();
  return id ? id : undefined;
}

/**
 * The authored tools for one case.
 *
 * An unknown case id throws rather than returning nothing. An empty toolbox is
 * indistinguishable from an agent that chose not to act, and that mistake would
 * be scored as the agent's.
 */
export function deskToolDefinitions(caseId: string): DeskTool[] {
  const desk = CONTINUITY_CASES.find((entry) => entry.domain.id === caseId);
  if (!desk) throw new Error(`Unknown desk case "${caseId}"; no continuity domain declares it`);
  return desk.domain.tools;
}

export function deskTools(http: TwinHttp, env: NodeJS.ProcessEnv = process.env): EngineTool[] {
  const caseId = deskCaseId(env);
  if (!caseId) return [];
  return deskToolDefinitions(caseId).map((tool) => ({
    name: tool.name,
    twin: "desk" as const,
    isMutation: tool.mutation,
    def: fn(tool.name, tool.description, tool.parameters),
    // The desk applies its own rules and owns the simulated instant. The agent
    // sends arguments and nothing else: an `at` supplied here would let a model
    // choose which deadline it had met.
    run: (input) => http.post(`/api/tools/${encodeURIComponent(tool.name)}`, { args: input }),
  }));
}
