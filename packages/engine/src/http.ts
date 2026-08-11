// One HTTP client for all three twins.
//
// Every twin is a local Next server. Its control plane (/api/sandbox/*,
// /api/activity) is gated by a static admin token (SANDBOX_TOKEN, default
// "sandbox-token") — the engine is an operator there, so a static token is the
// honest fit. The provider API, however, is moving behind real OAuth2 (Gmail
// first). When `oauth` is set, provider-API calls carry a real access token that
// this client mints on demand via the admin-gated POST /api/sandbox/token, and
// re-mints on a 401 (expiry / a reset that wiped tokens). Control-plane calls
// keep the admin token. This is what lets the engine talk the same wire protocol
// an agent would — if the engine can do it over HTTP, so can the customer's agent.
//
// `fetchImpl` is injectable so an adapter can be exercised against a stub in a
// test without a server, and without vitest-wide fetch monkey-patching leaking
// between files.

import type { TwinName } from "@sonata/core";

export const DEFAULT_SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/** Twins whose provider API is behind the sandbox's own OAuth2 server. */
const OAUTH_TWINS: readonly TwinName[] = ["gmail"];

export interface TwinHttpOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Guard against a hung twin taking the whole run's wall-clock budget. */
  timeoutMs?: number;
  /**
   * When true, provider-API calls use a real OAuth2 access token minted via
   * POST /api/sandbox/token (admin-gated) instead of the static token, with a
   * lazy acquire + re-mint-on-401. Control-plane calls keep the admin token.
   * Off by default so a twin not yet cut over to OAuth keeps working unchanged.
   */
  oauth?: boolean;
  /** Optional scope for the minted provider token; defaults to full mailbox access. */
  oauthScope?: string;
}

export class TwinHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "TwinHttpError";
  }
}

/** Query values that are undefined are omitted; arrays repeat the key. */
export type Query = Record<string, string | number | boolean | string[] | undefined>;

function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) sp.append(key, v);
    else sp.append(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class TwinHttp {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly oauth: boolean;
  private readonly oauthScope?: string;
  /** Lazily-minted provider access token (only used when `oauth` is set). */
  private oauthToken?: string;

  constructor(opts: TwinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? DEFAULT_SANDBOX_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.oauth = opts.oauth ?? false;
    this.oauthScope = opts.oauthScope;
  }

  /** Control-plane routes stay on the admin token; everything else is provider API. */
  private isControlPlane(path: string): boolean {
    return (
      path.startsWith("/api/sandbox") ||
      path.startsWith("/api/activity") ||
      path.startsWith("/api/health") ||
      path.startsWith("/api/eval")
    );
  }

  /** Mint (or re-mint) a provider access token via the admin-gated bridge. */
  private async mintProviderToken(): Promise<string> {
    const url = `${this.baseUrl}/api/sandbox/token`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "X-Sandbox-Token": this.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(this.oauthScope ? { scope: this.oauthScope } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new TwinHttpError(res.status, url, text);
    const json = JSON.parse(text) as { access_token?: string };
    if (!json.access_token) throw new Error(`mint endpoint returned no access_token: ${text.slice(0, 200)}`);
    this.oauthToken = json.access_token;
    return this.oauthToken;
  }

  private async request<T>(
    method: string,
    path: string,
    init: { query?: Query; json?: unknown; form?: Record<string, string> } = {},
  ): Promise<T> {
    const url = withQuery(`${this.baseUrl}${path}`, init.query);
    const useOAuth = this.oauth && !this.isControlPlane(path);

    const send = async (bearer: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      };
      // The sandbox control routes accept either header; sending X-Sandbox-Token
      // for them means one client works against a twin that gates /api/sandbox/*
      // and one that does not. Provider (OAuth) calls send only the bearer.
      if (!useOAuth) headers["X-Sandbox-Token"] = this.token;
      let body: string | undefined;
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.json);
      } else if (init.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(init.form).toString();
      }
      return this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    };

    let bearer = useOAuth ? this.oauthToken ?? (await this.mintProviderToken()) : this.token;
    let res = await send(bearer);
    // A 401 on a provider call means the token expired/was revoked or a reset
    // wiped it — re-mint once and retry before giving up.
    if (useOAuth && res.status === 401) {
      bearer = await this.mintProviderToken();
      res = await send(bearer);
    }
    const text = await res.text();
    if (!res.ok) throw new TwinHttpError(res.status, url, text);
    // 204 and other empty bodies are legitimate answers (Gmail's delete, the
    // calendar's cancel); returning undefined lets callers ignore them.
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, json?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { json, query });
  }

  /** Slack's SDK sends form-encoded args for simple calls; its twin accepts both. */
  postForm<T>(path: string, form: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, { form });
  }

  patch<T>(path: string, json: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, { json, query });
  }

  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }
}

/**
 * The client for one twin, with that twin's authentication already decided.
 *
 * Three callers build these — the engine's adapters, the agent's tools, and the
 * MCP server — and the day only two of them knew Gmail had moved behind OAuth2,
 * the third presented the admin token to /gmail/v1/* and 401'd on every read
 * while typecheck and the suites stayed green. Which twin needs what is answered
 * here and nowhere else. An explicit `oauth` still wins, for a twin mid-cutover.
 */
export function createTwinHttp(twin: TwinName, opts: TwinHttpOptions): TwinHttp {
  return new TwinHttp({ ...opts, oauth: opts.oauth ?? OAUTH_TWINS.includes(twin) });
}

/** `err.message` for anything thrown, without the `unknown` dance at each site. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
