import {
  ADMIN_TOKEN,
  API_URL,
  UI_CLIENT_ID,
  UI_CLIENT_SECRET,
} from "./oauth-config";
import { getSession, setSession, type Session } from "./session";

// Thin server-side client for the API service. Mirrors the harness's TwinHttp
// shape (duplicated per the no-shared-package convention). Attaches the OAuth
// bearer from the session cookie and transparently refreshes on expiry / 401.
// Only ever runs on the server — the client_secret and tokens never reach the
// browser.

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`API ${status}: ${body.slice(0, 300)}`);
    this.name = "ApiError";
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, item);
    else sp.append(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

async function refreshSession(session: Session): Promise<Session | null> {
  if (!session.refresh_token) return null;
  const res = await fetch(`${API_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      client_id: UI_CLIENT_ID,
      client_secret: UI_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token: string; scope?: string; expires_in?: number };
  return {
    access_token: t.access_token,
    refresh_token: session.refresh_token,
    scope: t.scope ?? session.scope,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}

async function call(path: string, init: RequestInit, token: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

/** Make an authenticated request to the API. Sessionless requests carry the
 *  static token: in the API's `token` mode that succeeds, and in `oauth` mode
 *  the API answers 401 — it stays the single source of truth by refusing. */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  let session = await getSession();
  if (!session) return call(path, init, ADMIN_TOKEN);

  // Proactively refresh a token that is expired or about to expire.
  if (session.refresh_token && Date.now() > session.expires_at - 5000) {
    const refreshed = await refreshSession(session);
    if (refreshed) {
      session = refreshed;
      await setSession(session);
    }
  }

  let res = await call(path, init, session.access_token);
  if (res.status === 401 && session.refresh_token) {
    const refreshed = await refreshSession(session);
    if (refreshed) {
      session = refreshed;
      await setSession(session);
      res = await call(path, init, session.access_token);
    }
  }
  return res;
}

export async function apiGet<T>(path: string, query?: Query): Promise<T> {
  const res = await apiRequest(withQuery(path, query), { method: "GET" });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiPost<T>(path: string, body: unknown, query?: Query): Promise<T> {
  const res = await apiRequest(withQuery(path, query), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
