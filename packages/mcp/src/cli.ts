import path from "node:path";
import { fileURLToPath } from "node:url";
import { configFromEnv, isServedTwin, TWINS, type ServedTwin } from "./config";
import { serveStdio } from "./server";
import { connectionSnippets, launchFor } from "./snippets";

// `sonata-mcp` serves all three twins; `sonata-mcp gmail` serves one.
//
// Serving one is not a nicety: a mailbox-only evaluation should hand the agent a
// mailbox and nothing else, because an agent that is given calendar tools it never
// uses looks exactly like an agent that had them and chose well. The connector has
// to be able to say "these are your surfaces today".

export interface ParsedArgv {
  twins: ServedTwin[];
  mode: "serve" | "connect" | "help";
  /** Unrecognised words, reported rather than ignored — a typo'd twin is a silent wrong run. */
  unknown: string[];
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const twins: ServedTwin[] = [];
  const unknown: string[] = [];
  let mode: ParsedArgv["mode"] = "serve";
  for (const raw of argv) {
    const arg = raw.trim().toLowerCase();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h" || arg === "help") mode = "help";
    else if (arg === "--connect" || arg === "connect") mode = "connect";
    else if (isServedTwin(arg)) {
      if (!twins.includes(arg)) twins.push(arg);
    } else unknown.push(raw);
  }
  return { twins: twins.length ? twins : [...TWINS], mode, unknown };
}

export function helpText(): string {
  return [
    "sonata-mcp — plug your agent into the Sonata twins over MCP (stdio).",
    "",
    "Usage:",
    "  sonata-mcp                    serve gmail, slack and calendar",
    "  sonata-mcp gmail              serve one twin (any subset works)",
    "  sonata-mcp connect            print connection config and exit",
    "",
    "Environment:",
    "  SONATA_TOKEN          bearer token the twins accept (default sandbox-token)",
    "  SONATA_GMAIL_URL      default http://localhost:3101",
    "  SONATA_SLACK_URL      default http://localhost:3200",
    "  SONATA_CALENDAR_URL   default http://localhost:3400",
    "",
  ].join("\n");
}

/** The repo root, from this file: packages/mcp/src/cli.ts -> ../../.. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function connectText(twins: readonly ServedTwin[]): string {
  const config = configFromEnv();
  const snippets = connectionSnippets({ config, twins, launch: launchFor(repoRoot(), twins) });
  return [
    "# Claude Code",
    snippets.claudeCode,
    "",
    "# Any client that reads an mcpServers block",
    snippets.mcpJson.trimEnd(),
    "",
    "# No MCP? Call the twins directly.",
    snippets.rest.trimEnd(),
    "",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgv(argv);
  if (parsed.unknown.length) {
    process.stderr.write(
      `sonata-mcp: unknown argument ${parsed.unknown.join(", ")}. Try --help.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.mode === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (parsed.mode === "connect") {
    // Safe to use stdout here: this mode prints and exits, so there is no protocol
    // stream to corrupt. While serving, everything goes to stderr.
    process.stdout.write(connectText(parsed.twins));
    return;
  }
  await serveStdio({ twins: parsed.twins });
}

/** One place for "it blew up before it could answer anything" — used by the bin too. */
export function run(argv?: readonly string[]): Promise<void> {
  return main(argv).catch((err: unknown) => {
    process.stderr.write(`sonata-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

// Started as a program (`tsx src/cli.ts`) rather than imported. Guarded so that a
// test importing `parseArgv` does not open a server on the test runner's stdio.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void run();
}
