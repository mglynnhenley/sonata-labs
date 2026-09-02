import { resolveTwinApiUrl, twinApiUrl, TWIN_NAMES, type TwinName } from "@sonata/core";

// Where the twins live and what token opens them.
//
// Everything is an env var with a working default, because the first thing a
// user does with this package is paste one command into their agent — asking
// them to supply a URL per surface before they have seen anything work is how a
// connector loses people at step one. The defaults are the ports the monorepo's
// own `dev:*` scripts bind.

/** The name the agent sees the server under, and the version it reports. */
export const SERVER_NAME = "sonata";

export const SERVER_VERSION = "0.1.0";

/**
 * Every twin, in @sonata/core's own order.
 *
 * This used to be a shorter list than `TWIN_NAMES` and no longer is: every twin
 * the engine drives has an adapter and a toolset, and the connector's whole
 * claim is that a customer's agent works the same surface the benchmark scores.
 * A twin served by one and not the other would break that claim silently.
 */
export const TWINS = TWIN_NAMES;

/**
 * Kept as a name because it says what it means at the call sites — "a twin this
 * server can front" — and it is now, deliberately, every twin there is.
 */
export type ServedTwin = TwinName;

/** Built rather than tabulated: @sonata/core's port table is the source of truth. */
export const DEFAULT_TWIN_URLS: Record<ServedTwin, string> = Object.fromEntries(
  TWINS.map((twin) => [twin, twinApiUrl(twin)]),
) as Record<ServedTwin, string>;

/**
 * What to tell a user whose twin is not answering. Written out rather than
 * derived from the twin's name, because it is a promise about what the root
 * package.json contains — and a start command that does not exist is worse than
 * no start command at all.
 */
export const START_COMMAND: Record<ServedTwin, string> = {
  gmail: "npm run dev:gmail",
  slack: "npm run dev:slack",
  calendar: "npm run dev:calendar",
  attio: "npm run dev:attio",
  "google-docs": "npm run dev:google-docs",
  "google-ads": "npm run dev:google-ads",
  linkedin: "npm run dev:linkedin",
};

/** The same default every twin's own auth.ts uses; the token is a seatbelt, not a lock. */
export const DEFAULT_TOKEN = "sandbox-token";

export interface SonataConfig {
  token: string;
  urls: Record<ServedTwin, string>;
}

/**
 * The spelling a generated snippet emits. One per twin, and always the SONATA_*
 * form: core accepts a second spelling for the three twins that grew one, and a
 * snippet that offered both would be teaching a user two ways to say one thing.
 * An underscore stands in for the hyphen, since `SONATA_GOOGLE-DOCS_URL` is not
 * a legal shell identifier.
 */
const URL_ENV: Record<ServedTwin, string> = {
  gmail: "SONATA_GMAIL_URL",
  slack: "SONATA_SLACK_URL",
  calendar: "SONATA_CALENDAR_URL",
  attio: "SONATA_ATTIO_URL",
  "google-docs": "SONATA_GOOGLE_DOCS_URL",
  "google-ads": "SONATA_GOOGLE_ADS_URL",
  linkedin: "SONATA_LINKEDIN_URL",
};

export function isServedTwin(name: string): name is ServedTwin {
  return (TWINS as readonly string[]).includes(name);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SonataConfig {
  const urls = {} as Record<ServedTwin, string>;
  for (const twin of TWINS) {
    // Resolved through core so both env spellings work here exactly as they do
    // for the engine and the dashboard. `URL_ENV` above stays the canonical
    // name to *emit* — a generated snippet should offer one way to spell it.
    urls[twin] = resolveTwinApiUrl(twin, env);
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

/** Every twin's canonical URL variable, for help text that cannot go stale. */
export function urlEnvFor(twin: ServedTwin): string {
  return URL_ENV[twin];
}
