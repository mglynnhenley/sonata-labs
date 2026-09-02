import { TWIN_NAMES, type TwinName } from "./types/world";

// Where every service lives, in one place.
//
// Each twin is two deployables: an API service (the provider-shaped surface an
// agent calls, behind OAuth) and a UI service (a web client that authenticates
// to that API as a real third-party OAuth client). The API ports are the ones
// that have always been used, so every existing env fallback keeps working.
//
// Contracts only, per the package charter: these are constants and pure
// functions. Nothing here reads process.env — the resolvers take an env object
// so they stay testable and this module keeps doing no I/O.

/** The provider API for each twin. Unchanged, and not to be renumbered. */
export const TWIN_API_PORTS: Record<TwinName, number> = {
  gmail: 3101,
  slack: 3200,
  calendar: 3400,
  attio: 3500,
  "google-docs": 3600,
};

/** The web UI for each twin: API port + 800, so the pairing is guessable. */
export const TWIN_UI_PORTS: Record<TwinName, number> = {
  gmail: 3901,
  slack: 4000,
  calendar: 4200,
  attio: 4300,
  "google-docs": 4400,
};

/**
 * Twins that actually ship a UI service today. Gmail is the pilot; every other
 * twin keeps its port reserved above but has no `apps/<twin>-ui` yet. Add to
 * this list as each one lands, and the orchestration follows.
 */
export const TWINS_WITH_UI: readonly TwinName[] = ["gmail"];

export function hasUiService(twin: TwinName): boolean {
  return TWINS_WITH_UI.includes(twin);
}

/**
 * Env vars consulted for a twin's API URL, in precedence order.
 *
 * Two spellings because two grew up independently: the dashboard, world builder
 * and MCP server read `SONATA_<TWIN>_URL`, while the engine adapters read
 * `<TWIN>_TWIN_URL`. Both are honoured so neither existing setup breaks, and
 * every consumer now resolves them identically — before this, exporting
 * `SONATA_GMAIL_URL` moved three consumers and silently left the engine behind.
 */
export const TWIN_API_URL_ENV: Record<TwinName, readonly string[]> = {
  gmail: ["SONATA_GMAIL_URL", "GMAIL_TWIN_URL"],
  slack: ["SONATA_SLACK_URL", "SLACK_TWIN_URL"],
  calendar: ["SONATA_CALENDAR_URL", "CALENDAR_TWIN_URL"],
  // The newer two get both spellings from the start, so no consumer has to know
  // which generation of twin it is talking to. An underscore stands in for the
  // hyphen: `SONATA_GOOGLE-DOCS_URL` is not a legal shell identifier and could
  // not be exported.
  attio: ["SONATA_ATTIO_URL", "ATTIO_TWIN_URL"],
  "google-docs": ["SONATA_GOOGLE_DOCS_URL", "GOOGLE_DOCS_TWIN_URL"],
};

export const TWIN_UI_URL_ENV: Record<TwinName, readonly string[]> = {
  gmail: ["SONATA_GMAIL_UI_URL", "GMAIL_UI_URL"],
  slack: ["SONATA_SLACK_UI_URL", "SLACK_UI_URL"],
  calendar: ["SONATA_CALENDAR_UI_URL", "CALENDAR_UI_URL"],
  attio: ["SONATA_ATTIO_UI_URL", "ATTIO_UI_URL"],
  "google-docs": ["SONATA_GOOGLE_DOCS_UI_URL", "GOOGLE_DOCS_UI_URL"],
};

/**
 * `localhost` can resolve to ::1 while a dev server listens on IPv4 only, which
 * shows up as a connection refused that looks like the twin is down. Callers
 * that have been bitten (the world injector) pass the literal loopback address.
 */
export type UrlOptions = { host?: string };

function url(port: number, opts?: UrlOptions): string {
  return `http://${opts?.host ?? "localhost"}:${port}`;
}

export function twinApiUrl(twin: TwinName, opts?: UrlOptions): string {
  return url(TWIN_API_PORTS[twin], opts);
}

export function twinUiUrl(twin: TwinName, opts?: UrlOptions): string {
  return url(TWIN_UI_PORTS[twin], opts);
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function fromEnv(names: readonly string[], env: Record<string, string | undefined>): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** Explicit override beats env, env beats the default. Trailing slashes dropped. */
export function resolveTwinApiUrl(
  twin: TwinName,
  env: Record<string, string | undefined> = {},
  opts?: UrlOptions & { override?: string },
): string {
  return trimSlashes(opts?.override ?? fromEnv(TWIN_API_URL_ENV[twin], env) ?? twinApiUrl(twin, opts));
}

export function resolveTwinUiUrl(
  twin: TwinName,
  env: Record<string, string | undefined> = {},
  opts?: UrlOptions & { override?: string },
): string {
  return trimSlashes(opts?.override ?? fromEnv(TWIN_UI_URL_ENV[twin], env) ?? twinUiUrl(twin, opts));
}

/** Every API URL at once, for callers that fan out over every twin. */
export function allTwinApiUrls(
  env: Record<string, string | undefined> = {},
  opts?: UrlOptions,
): Record<TwinName, string> {
  const out = {} as Record<TwinName, string>;
  for (const twin of TWIN_NAMES) out[twin] = resolveTwinApiUrl(twin, env, opts);
  return out;
}
