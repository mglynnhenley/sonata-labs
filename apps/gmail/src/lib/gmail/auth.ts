import { unauthorized } from "./errors";
import type { NextResponse } from "next/server";

// Static bearer token auth for /gmail/v1/*. The sandbox isn't protecting real
// data — it exists so the official SDK's auth path works unchanged (agents pass
// an OAuth2Client whose access_token becomes an Authorization: Bearer header).
//
// Configure via SANDBOX_TOKEN env; defaults to a well-known dev token.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/**
 * Returns null if authorized, or a 401 NextResponse if not.
 * Accepts `Authorization: Bearer <token>` (what the SDK sends via
 * OAuth2Client.setCredentials) and, as a convenience, `?access_token=`.
 */
export function checkAuth(req: Request): NextResponse | null {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  let token = m?.[1];
  if (!token) {
    token = new URL(req.url).searchParams.get("access_token") || undefined;
  }
  if (token !== SANDBOX_TOKEN) {
    return unauthorized();
  }
  return null;
}
