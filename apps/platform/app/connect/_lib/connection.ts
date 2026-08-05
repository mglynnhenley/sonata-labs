import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  configFromEnv,
  connectionSnippets,
  launchFor,
  SERVER_NAME,
  SERVER_VERSION,
  TWINS,
  buildTools,
  type ConnectionSnippets,
  type ServedTwin,
  type SonataConfig,
} from "@sonata/mcp";
import { TWIN_LABELS, twinUrl } from "@/lib/twins";

// Everything the Connect page needs to print, worked out on the server.
//
// The snippets are not written here — they come from @sonata/mcp, which is also
// what the CLI prints and what the connector's own tests assert on. This file's
// whole job is to fill that generator's three blanks with things only the running
// dashboard knows: which checkout this is, which ports the twins are actually on,
// and whether `npm install` has linked the launcher yet.

/** The launcher npm links at install time; naming it is how the snippet stays copy-pasteable. */
const BIN = path.join("node_modules", ".bin", "sonata-mcp");

/** How far up to look before admitting we cannot find the checkout. */
const MAX_CLIMB = 8;

function hasWorkspaces(dir: string): boolean {
  const pkg = path.join(dir, "package.json");
  if (!existsSync(pkg)) return false;
  try {
    return (JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown }).workspaces !== undefined;
  } catch {
    // A package.json we cannot parse tells us nothing either way; keep climbing.
    return false;
  }
}

/**
 * The checkout whose install linked `sonata-mcp`.
 *
 * That, and not "the workspace root", is the definition the snippet needs: the
 * path goes into a command the user will paste into another program, and a path
 * to a bin that is not there is a connection that fails with ENOENT inside the
 * agent, where nobody can see it. When the bin is missing we still name the
 * workspace root — the command is right, the install is what is missing — and say
 * so on the page instead of printing something that cannot work without a word.
 */
export function locateCheckout(): { root: string; binInstalled: boolean } {
  let dir = process.cwd();
  let workspaceRoot: string | null = null;
  for (let i = 0; i < MAX_CLIMB; i++) {
    if (existsSync(path.join(dir, BIN))) return { root: dir, binInstalled: true };
    if (workspaceRoot === null && hasWorkspaces(dir)) workspaceRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: workspaceRoot ?? process.cwd(), binInstalled: false };
}

/**
 * The config the snippets are rendered from.
 *
 * The token comes from the environment, exactly as the connector will read it.
 * The URLs come from the dashboard's twin registry rather than from
 * `configFromEnv`, because the registry is what this page shows health for and
 * what its Start buttons control — a snippet naming a different host than the
 * card directly above it would be a lie, and the user would only find out inside
 * their own agent.
 */
export function connectConfig(): SonataConfig {
  const urls = {} as Record<ServedTwin, string>;
  for (const twin of TWINS) urls[twin] = twinUrl(twin);
  return { token: configFromEnv().token, urls };
}

export interface TwinTools {
  twin: ServedTwin;
  label: string;
  url: string;
  count: number;
}

export interface ConnectionView {
  /** The name the agent will see the server under. */
  serverName: string;
  serverVersion: string;
  token: string;
  /** The absolute path the snippet names, and whether the launcher is there. */
  repoRoot: string;
  command: string;
  binInstalled: boolean;
  /** Every tool the agent gets, including the one that spans all three twins. */
  toolTotal: number;
  perTwin: TwinTools[];
  /** Tools that belong to no single twin, by name — `sonata_whats_new`. */
  crossTwin: string[];
  snippets: ConnectionSnippets;
}

/**
 * The page's whole payload. Pure apart from reading the filesystem for the
 * checkout, so the page can render it server-side and an API caller can ask for
 * the same thing without a browser.
 */
export function connectionView(): ConnectionView {
  const config = connectConfig();
  const { root, binInstalled } = locateCheckout();
  const launch = launchFor(root);
  const { entries } = buildTools({ config });

  const perTwin: TwinTools[] = TWINS.map((twin) => ({
    twin,
    label: TWIN_LABELS[twin],
    url: config.urls[twin],
    // By name, not by `entry.twin`: the cross-twin poller is filed under Gmail so
    // its failures have somewhere to point, and counting it there would say Gmail
    // has thirteen tools when the agent can only call twelve of them at Gmail.
    count: entries.filter((entry) => entry.name.startsWith(`${twin}_`)).length,
  }));

  return {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    token: config.token,
    repoRoot: root,
    command: launch.command,
    binInstalled,
    toolTotal: entries.length,
    perTwin,
    crossTwin: entries
      .filter((entry) => !TWINS.some((twin) => entry.name.startsWith(`${twin}_`)))
      .map((entry) => entry.name),
    snippets: connectionSnippets({ config, launch }),
  };
}
