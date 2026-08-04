// One HTTP client for all three twins.
//
// Every twin is a local Next server behind a static bearer token (SANDBOX_TOKEN,
// defaulting to "sandbox-token" in each app's auth.ts) — the token exists so the
// official SDKs' auth path works unchanged, not to protect anything. The engine
// talks the same wire protocol an agent would, which is what keeps the twins
// honest: if the engine can do it over HTTP, so can the customer's agent.
//
// `fetchImpl` is injectable so an adapter can be exercised against a stub in a
// test without a server, and without vitest-wide fetch monkey-patching leaking
// between files.

export const DEFAULT_SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

export interface TwinHttpOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Guard against a hung twin taking the whole run's wall-clock budget. */
  timeoutMs?: number;
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

  constructor(opts: TwinHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? DEFAULT_SANDBOX_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    method: string,
    path: string,
    init: { query?: Query; json?: unknown; form?: Record<string, string> } = {},
  ): Promise<T> {
    const url = withQuery(`${this.baseUrl}${path}`, init.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      // The sandbox control routes accept either header; sending both means one
      // client works against a twin that gates /api/sandbox/* and one that does not.
      "X-Sandbox-Token": this.token,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
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

/** `err.message` for anything thrown, without the `unknown` dance at each site. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
