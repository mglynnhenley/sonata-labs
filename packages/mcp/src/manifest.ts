import { createTwinHttp, TwinHttp } from "@sonata/engine/http";
import { calendarTools, gmailTools, slackTools, type EngineTool } from "@sonata/engine/tools/index";
import { asServedTwin, TWINS, type ServedTwin, type SonataConfig } from "./config";

// The tool manifest, derived — not copied — from packages/engine/src/tools.
//
// The whole point of the connector is that the agent a customer plugs in works
// the same surface the benchmark scores. If the MCP vocabulary were written out
// again here, the two would drift the first time a description was reworded, and
// the drift would be invisible: the benchmark would keep passing while the
// customer's agent was being told something else. So the engine's tools ARE the
// manifest. Names, descriptions and schemas come off `EngineTool.def` verbatim,
// and execution is the engine's own `run`, which speaks the twin's REST API over
// the same TwinHttp the episode engine uses.
//
// The one thing added is the prefix: an agent sees all three sets at once, and
// three tools called `send_message` in one list is a coin toss.

/** The JSON Schema shape MCP's tools/list requires — an object schema, always. */
export interface ObjectSchema {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  /** Open, because a schema the engine writes may carry keys MCP does not name. */
  [key: string]: unknown;
}

export interface McpToolEntry {
  /** Twin-prefixed and self-describing: `gmail_list_messages`, `slack_send_message`. */
  name: string;
  twin: ServedTwin;
  /** The engine's own name for it — the join key that proves the two cannot drift. */
  engineName: string;
  description: string;
  inputSchema: ObjectSchema;
  /** Mutations leave audit rows behind; reads do not. Surfaced as MCP's readOnlyHint. */
  isMutation: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface TwinClient {
  twin: ServedTwin;
  baseUrl: string;
  http: TwinHttp;
}

export interface ClientOptions {
  config: SonataConfig;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * One HTTP client per twin, carrying the bearer token every call needs.
 *
 * `createTwinHttp` decides which twin needs OAuth2 rather than this file: Gmail
 * sits behind a real authorization server, so SONATA_TOKEN is only an admin
 * credential there and presenting it to /gmail/v1/* earns a 401. Going through
 * the engine's own constructor is what makes an agent connected over MCP and an
 * agent driven by the engine authenticate identically.
 */
export function twinClient(twin: ServedTwin, opts: ClientOptions): TwinClient {
  const baseUrl = opts.config.urls[twin];
  return {
    twin,
    baseUrl,
    http: createTwinHttp(twin, {
      baseUrl,
      token: opts.config.token,
      fetchImpl: opts.fetchImpl,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    }),
  };
}

/** The engine's curated toolset for one twin, unchanged. */
export function engineToolsFor(twin: ServedTwin, http: TwinHttp): EngineTool[] {
  if (twin === "gmail") return gmailTools(http);
  if (twin === "slack") return slackTools(http);
  return calendarTools(http);
}

/** `gmail` + `list_messages` -> `gmail_list_messages`. */
export function prefixed(twin: ServedTwin, engineName: string): string {
  return `${twin}_${engineName}`;
}

/**
 * The parameters off an OpenAI function definition, as an MCP input schema.
 *
 * Both sides are JSON Schema, so this is a narrowing rather than a translation:
 * anything the engine writes is carried through, and the only thing asserted is
 * the object-ness MCP requires. A tool whose schema were reshaped here would be a
 * tool that behaves differently in the connector than in the benchmark.
 */
export function toInputSchema(parameters: unknown): ObjectSchema {
  if (!parameters || typeof parameters !== "object") return { type: "object", properties: {} };
  const raw = parameters as Record<string, unknown>;
  const properties =
    raw.properties && typeof raw.properties === "object"
      ? (raw.properties as Record<string, object>)
      : {};
  const required = Array.isArray(raw.required) ? raw.required.filter((r): r is string => typeof r === "string") : [];
  return { ...raw, type: "object", properties, ...(required.length ? { required } : {}) };
}

export function toEntry(tool: EngineTool): McpToolEntry {
  // Harness-local tools (twin: null) never reach here — they are the engine's own
  // escalation and note-taking, which belong to a scored episode, not to a live
  // connection. Anything else would be a new tool the engine grew without a home.
  if (tool.twin === null) throw new Error(`engine tool "${tool.name}" has no twin and cannot be served over MCP`);
  const twin = asServedTwin(tool.twin);
  if (tool.def.type !== "function") throw new Error(`engine tool "${tool.name}" is not a function tool`);
  return {
    name: prefixed(twin, tool.name),
    twin,
    engineName: tool.name,
    description: tool.def.function.description ?? "",
    inputSchema: toInputSchema(tool.def.function.parameters),
    isMutation: tool.isMutation,
    run: (args) => tool.run(args),
  };
}

export interface ManifestOptions extends ClientOptions {
  /** Which twins this process fronts. Defaults to all three. */
  twins?: readonly ServedTwin[];
}

export interface Manifest {
  entries: McpToolEntry[];
  clients: Map<ServedTwin, TwinClient>;
}

/** Every served twin's tools, prefixed, in a stable order. */
export function buildManifest(opts: ManifestOptions): Manifest {
  const twins = opts.twins ?? TWINS;
  const clients = new Map<ServedTwin, TwinClient>();
  const entries: McpToolEntry[] = [];
  for (const twin of TWINS) {
    if (!twins.includes(twin)) continue;
    const client = twinClient(twin, opts);
    clients.set(twin, client);
    for (const tool of engineToolsFor(twin, client.http)) entries.push(toEntry(tool));
  }
  return { entries, clients };
}
