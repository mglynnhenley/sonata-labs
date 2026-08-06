import { cookies } from "next/headers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { COOKIE_SECRET, IS_PROD } from "./oauth-config";

// Encrypted, HttpOnly cookies. The session cookie holds the OAuth token pair —
// the browser never sees it. A second short-lived cookie carries the in-flight
// `state` + PKCE `verifier` between the login redirect and the callback. Both are
// AES-256-GCM sealed so the browser can neither read nor forge them.

const SESSION_COOKIE = "gm_session";
const FLOW_COOKIE = "gm_oauth_flow";

export interface Session {
  access_token: string;
  refresh_token?: string;
  scope: string;
  /** epoch ms when the access token expires. */
  expires_at: number;
}

export interface FlowState {
  state: string;
  verifier: string;
  /** A nonce bound to the authorize page — echoed by the consent POST (CSRF). */
  nonce?: string;
}

function key(): Buffer {
  return createHash("sha256").update(COOKIE_SECRET).digest();
}

function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64url");
}

function unseal<T>(token: string | undefined): T | null {
  if (!token) return null;
  try {
    const buf = Buffer.from(token, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

const base = { httpOnly: true as const, sameSite: "lax" as const, path: "/", secure: IS_PROD };

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return unseal<Session>(store.get(SESSION_COOKIE)?.value);
}

export async function setSession(session: Session): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, seal(session), { ...base, maxAge: 60 * 60 * 24 * 7 });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function setFlow(flow: FlowState): Promise<void> {
  const store = await cookies();
  store.set(FLOW_COOKIE, seal(flow), { ...base, maxAge: 600 }); // 10 min to complete consent
}

/** Read and clear the in-flight flow cookie (single-use). */
export async function takeFlow(): Promise<FlowState | null> {
  const store = await cookies();
  const flow = unseal<FlowState>(store.get(FLOW_COOKIE)?.value);
  store.delete(FLOW_COOKIE);
  return flow;
}
