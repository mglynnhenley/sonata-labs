import type { NextResponse } from "next/server";
import { unauthorized } from "./errors";

// Static bearer token auth for /v1/*. The sandbox is not protecting real data —
// it exists so the official SDK's auth path works unchanged: an OAuth2Client's
// access_token becomes an `Authorization: Bearer` header, and that is the whole
// credential story for this clone.
//
// The control-plane gate is NOT here. This clone follows the Gmail twin's split
// and it lives in src/lib/sandbox/auth.ts, because /api/sandbox/* answers a plain
// `{ok:false,error}` rather than the Docs envelope.
//
// Configure via SANDBOX_TOKEN env; defaults to a well-known dev token.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return new URL(req.url).searchParams.get("access_token") || undefined;
}

/**
 * Returns null if authorized, or a 401 NextResponse if not. Accepts
 * `Authorization: Bearer <token>` (what the SDK sends via
 * OAuth2Client.setCredentials) and, as a convenience, `?access_token=`.
 */
export function checkAuth(req: Request): NextResponse | null {
  return bearerToken(req) === SANDBOX_TOKEN ? null : unauthorized();
}
