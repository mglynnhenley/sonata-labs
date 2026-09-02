import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  configFromEnv,
  SERVER_NAME,
  SERVER_VERSION,
  TWINS,
  type ServedTwin,
  type SonataConfig,
} from "./config";
import { twinFailure } from "./errors";
import { buildManifest, type McpToolEntry } from "./manifest";
import { validateArgs } from "./validate";
import { createWhatsNewTool } from "./whatsNew";

// The server: a thin interpreter over the manifest.
//
// There is deliberately no per-tool code here. Every tool in the list came off
// packages/engine/src/tools, and executing one is "call its run, JSON the result,
// or turn the failure into a sentence a language model can act on". Anything more
// clever in this file would be behaviour the benchmark cannot see, and behaviour
// the benchmark cannot see is behaviour that will disagree with it.

const INSTRUCTIONS =
  "You are plugged into Sonata: a simulated company with a real mailbox, a real Slack " +
  "workspace and a real calendar. Nothing here reaches the outside world, so act as you " +
  "would for a person — read before you write, and send what you would send. The world " +
  "keeps moving on its own clock whether or not you are looking: mail arrives, people " +
  "post, meetings move. Call sonata_whats_new on a loop to notice, then use the " +
  "gmail_*, slack_* and calendar_* tools to act.";

export interface ServeOptions {
  /** Which twins to front. Defaults to every twin. */
  twins?: readonly ServedTwin[];
  config?: SonataConfig;
  /** Injectable for tests; the real server uses global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface BuiltServer {
  server: Server;
  entries: McpToolEntry[];
  config: SonataConfig;
  twins: readonly ServedTwin[];
}

/** The full tool list: every served twin's tools, plus the one cross-twin poll. */
export function buildTools(opts: ServeOptions = {}): {
  entries: McpToolEntry[];
  config: SonataConfig;
  twins: readonly ServedTwin[];
} {
  const config = opts.config ?? configFromEnv();
  const twins = opts.twins ?? TWINS;
  const { entries, clients } = buildManifest({
    config,
    twins,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const whatsNew = createWhatsNewTool({
    entries,
    baseUrlFor: (twin) => clients.get(twin)?.baseUrl ?? config.urls[twin],
    ...(opts.now ? { now: opts.now } : {}),
  });
  // First in the list on purpose: it is the tool a plugged-in agent should reach
  // for before any other, and tool order is the only ranking MCP gives us.
  return { entries: [whatsNew, ...entries], config, twins };
}

/** The manifest as MCP's tools/list answers it. */
export function toolDescriptors(entries: McpToolEntry[]): Tool[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    annotations: {
      // A read is safe to retry and changes nothing; a mutation is the thing that
      // leaves an audit row and gets scored. Clients that ask before acting ask
      // about exactly this.
      readOnlyHint: !entry.isMutation,
      destructiveHint: entry.isMutation,
      idempotentHint: !entry.isMutation,
      openWorldHint: false,
    },
  }));
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Run one tool and shape the answer.
 *
 * Errors come back as `isError` results rather than protocol errors: a protocol
 * error is a client-side exception the agent may never see the text of, and the
 * text is the whole point — "the slack twin is not running, start it with npm run
 * dev:slack" is a fixable problem, "TypeError: fetch failed" is not.
 */
export async function callTool(
  entries: McpToolEntry[],
  name: string,
  args: Record<string, unknown>,
  baseUrlFor: (twin: ServedTwin) => string,
): Promise<CallToolResult> {
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    const known = entries.map((e) => e.name).join(", ");
    return textResult(`No Sonata tool called "${name}". Available: ${known}`, true);
  }
  const supplied = args ?? {};
  // Before the twin, not after: an argument the engine would coerce to "" turns
  // into a URL the twin answers with something plausible and wrong. See ./validate.
  const invalid = validateArgs(entry.name, entry.inputSchema, supplied);
  if (invalid) return textResult(invalid, true);
  try {
    const result = await entry.run(supplied);
    return textResult(JSON.stringify(result ?? { ok: true }, null, 2));
  } catch (err) {
    return textResult(twinFailure(entry.twin, baseUrlFor(entry.twin), err), true);
  }
}

/** The server, wired but not connected — connect it to a transport to serve. */
export function createServer(opts: ServeOptions = {}): BuiltServer {
  const { entries, config, twins } = buildTools(opts);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDescriptors(entries) }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(
      entries,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      (twin) => config.urls[twin],
    ),
  );

  return { server, entries, config, twins };
}

/**
 * Serve on stdio until the client disconnects.
 *
 * Every diagnostic goes to stderr, without exception: stdout is the protocol
 * channel, and one stray console.log there desyncs the JSON-RPC stream and takes
 * the whole connection down with a parse error nobody can read.
 */
export async function serveStdio(opts: ServeOptions = {}): Promise<BuiltServer> {
  const built = createServer(opts);
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  const list = built.twins.join(", ");
  process.stderr.write(
    `sonata-mcp: serving ${built.entries.length} tools over stdio for ${list}\n` +
      built.twins.map((t) => `  ${t.padEnd(9)} ${built.config.urls[t]}\n`).join(""),
  );
  return built;
}
