import type { TwinName } from "@sonata/core";

// Where the three twins live and what token opens them.
//
// Everything is an env var with a working default, because the first thing a
// user does with this package is paste one command into their agent — asking
// them to supply three URLs before they have seen anything work is how a
// connector loses people at step one. The defaults are the ports the monorepo's
// own `dev:*` scripts bind.

/** The name the agent sees the server under, and the version it reports. */
export const SERVER_NAME = "sonata";

export const SERVER_VERSION = "0.1.0";

export const TWINS = ["gmail", "slack", "calendar"] as const;

export type ServedTwin = (typeof TWINS)[number];

export const DEFAULT_TWIN_URLS: Record<ServedTwin, string> = {
  gmail: "http://localhost:3101",
  slack: "http://localhost:3200",
  calendar: "http://localhost:3400",
};

/** What to tell a user whose twin is not answering. Keyed by twin, from the root. */
export const START_COMMAND: Record<ServedTwin, string> = {
  gmail: "npm run dev:gmail",
  slack: "npm run dev:slack",
  calendar: "npm run dev:calendar",
};

/** The same default every twin's own auth.ts uses; the token is a seatbelt, not a lock. */
export const DEFAULT_TOKEN = "sandbox-token";

export interface SonataConfig {
  token: string;
  urls: Record<ServedTwin, string>;
}

const URL_ENV: Record<ServedTwin, string> = {
  gmail: "SONATA_GMAIL_URL",
  slack: "SONATA_SLACK_URL",
  calendar: "SONATA_CALENDAR_URL",
};

export function isServedTwin(name: string): name is ServedTwin {
  return (TWINS as readonly string[]).includes(name);
}

/** Narrow @sonata/core's TwinName to the three this server can front. */
export function asServedTwin(twin: TwinName): ServedTwin {
  if (!isServedTwin(twin)) throw new Error(`no MCP transport for twin "${twin}"`);
  return twin;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SonataConfig {
  const urls = {} as Record<ServedTwin, string>;
  for (const twin of TWINS) {
    urls[twin] = trimSlashes(env[URL_ENV[twin]] || DEFAULT_TWIN_URLS[twin]);
  }
  // SANDBOX_TOKEN is accepted too: it is what the twins themselves read, so a
  // shell already set up to curl them needs no second variable.
  return { token: env.SONATA_TOKEN || env.SANDBOX_TOKEN || DEFAULT_TOKEN, urls };
}

/** The env a launcher must set to reproduce this config — ordered, so snippets are stable. */
export function envFor(config: SonataConfig, twins: readonly ServedTwin[] = TWINS): Record<string, string> {
  const out: Record<string, string> = { SONATA_TOKEN: config.token };
  for (const twin of TWINS) {
    if (!twins.includes(twin)) continue;
    out[URL_ENV[twin]] = config.urls[twin];
  }
  return out;
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
