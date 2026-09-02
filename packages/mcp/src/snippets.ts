import { envFor, SERVER_NAME, TWINS, type ServedTwin, type SonataConfig } from "./config";

// Ready-to-paste connection config. Pure functions, no IO: the platform's Connect
// page renders these server-side, the CLI prints the same strings, and a test can
// assert on them character for character.
//
// Three forms because there are three kinds of agent: one that speaks `claude mcp
// add`, one that wants an mcpServers block in its own config file, and one that
// speaks no MCP at all and will just call the REST APIs. The third is not a
// consolation prize — the twins are the product, MCP is one door into them.

export interface LaunchSpec {
  command: string;
  args: string[];
}

export interface SnippetInput {
  config: SonataConfig;
  /** Which twins this connection serves. Defaults to every twin. */
  twins?: readonly ServedTwin[];
  /** How to start the server. Defaults to the bin the workspace install links. */
  launch?: LaunchSpec;
  /** The name the agent will see the server under. */
  serverName?: string;
}

export interface ConnectionSnippets {
  claudeCode: string;
  mcpJson: string;
  rest: string;
}

/**
 * The launcher for a checkout at `repoRoot`.
 *
 * The linked bin rather than `npx @sonata/mcp`: the package is private and lives
 * in this repo, so the thing that certainly exists on the user's machine is the
 * symlink npm made at install time. Twin arguments are positional, so one launch
 * spec covers "all three" and "just Gmail" without a flag.
 */
export function launchFor(repoRoot: string, twins?: readonly ServedTwin[]): LaunchSpec {
  const root = repoRoot.replace(/\/+$/, "");
  const args = twins && twins.length < TWINS.length ? [...twins] : [];
  return { command: `${root}/node_modules/.bin/sonata-mcp`, args };
}

function resolve(input: SnippetInput): {
  twins: readonly ServedTwin[];
  launch: LaunchSpec;
  name: string;
  env: Record<string, string>;
} {
  const twins = input.twins ?? TWINS;
  const launch = input.launch ?? { command: "sonata-mcp", args: [] };
  return {
    twins,
    launch,
    name: input.serverName ?? SERVER_NAME,
    env: envFor(input.config, twins),
  };
}

/** Shell-quote only when it would otherwise break — quoted paths read as noise. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `claude mcp add sonata --env … -- /path/to/sonata-mcp` */
export function claudeCodeSnippet(input: SnippetInput): string {
  const { launch, name, env } = resolve(input);
  const parts = ["claude", "mcp", "add", name];
  for (const [key, value] of Object.entries(env)) parts.push("--env", shellArg(`${key}=${value}`));
  parts.push("--", shellArg(launch.command), ...launch.args.map(shellArg));
  return parts.join(" ");
}

/** The generic block: Cursor, Windsurf, Claude Desktop and anything else that reads mcpServers. */
export function mcpServersJson(input: SnippetInput): string {
  const { launch, name, env } = resolve(input);
  return `${JSON.stringify(
    { mcpServers: { [name]: { command: launch.command, args: launch.args, env } } },
    null,
    2,
  )}\n`;
}

/** For agents that speak no MCP: the base URLs, the token, and one call that works. */
export function restSnippet(input: SnippetInput): string {
  const { twins, env } = resolve(input);
  const shape: Record<ServedTwin, string> = {
    gmail: "Gmail API v1        e.g. GET /gmail/v1/users/me/messages?labelIds=INBOX",
    slack: "Slack Web API       e.g. POST /api/conversations.list",
    calendar: "Google Calendar v3  e.g. GET /calendar/v3/users/me/calendarList",
    attio: "Attio API v2        e.g. GET /v2/tasks",
    // No list method, and that is the vendor's design rather than a gap in the
    // clone: finding a document is Drive's job. An agent reaches one through the
    // link it was sent; a human poking at it reads the sandbox's own projection.
    "google-docs": "Google Docs v1      e.g. GET /api/sandbox/snapshot (no list method exists)",
  };
  const lines = [
    "# Sonata twins over plain HTTP — the same surface the MCP tools call.",
    `# Every twin but Gmail takes: Authorization: Bearer ${input.config.token}`,
    "",
  ];
  for (const twin of TWINS) {
    if (!twins.includes(twin)) continue;
    lines.push(`${twin.padEnd(12)} ${input.config.urls[twin]}   ${shape[twin]}`);
  }
  // Gmail is behind the clone's own OAuth2 server; the token above is admin-only
  // there and earns a 401 on /gmail/v1/*. Printing the curl that works is the
  // difference between "connect" and "connect, then debug a 401 for an hour".
  const gmail = twins.includes("gmail") ? input.config.urls.gmail : null;
  if (gmail) {
    lines.push(
      "",
      "# Gmail's /gmail/v1/* takes an OAuth2 access token, not the token above.",
      "# Mint one through the admin bridge, then call:",
      `TOKEN=$(curl -s -X POST ${gmail}/api/sandbox/token \\`,
      `  -H "Authorization: Bearer ${env.SONATA_TOKEN}" -H "Content-Type: application/json" \\`,
      "  -d '{}' | jq -r .access_token)",
      "",
      'curl -s -H "Authorization: Bearer $TOKEN" \\',
      `  "${gmail}${sample("gmail")}"`,
    );
  }
  const rest = twins.find((twin) => twin !== "gmail");
  if (rest) {
    lines.push(
      "",
      `curl -s -H "Authorization: Bearer ${env.SONATA_TOKEN}" \\`,
      `  "${input.config.urls[rest]}${sample(rest)}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One read per twin that needs no id, so the printed curl runs as pasted. */
function sample(twin: ServedTwin): string {
  switch (twin) {
    case "gmail":
      return "/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10";
    case "slack":
      return "/api/conversations.list";
    case "calendar":
      return "/calendar/v3/users/me/calendarList";
    case "attio":
      return "/v2/tasks";
    // Every other twin's sample is a provider read. This one cannot be: the Docs
    // API has no call that answers "what is in this workspace".
    case "google-docs":
      return "/api/sandbox/snapshot";
  }
}

export function connectionSnippets(input: SnippetInput): ConnectionSnippets {
  return {
    claudeCode: claudeCodeSnippet(input),
    mcpJson: mcpServersJson(input),
    rest: restSnippet(input),
  };
}
