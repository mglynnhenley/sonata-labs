import { unauthorized, errorResponse } from "./errors";
import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { getDb } from "../db";
import { validateAccessToken } from "../oauth/service";
import { hasScope } from "../oauth/scopes";
import type { TokenRow } from "../oauth/store";

// Auth for /gmail/v1/*. As of the OAuth cutover this validates a real OAuth2
// access token against `oauth_tokens` (unrevoked, unexpired) minted by the
// sandbox's own authorization server — the agent passes an OAuth2Client whose
// access_token becomes an `Authorization: Bearer` header, exactly as against
// real Gmail.
//
// SANDBOX_TOKEN survives ONLY as the control-plane admin token (/api/sandbox/*,
// see ../sandbox/auth.ts). It is no longer accepted on the provider API.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

function extractToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  // Convenience mirror of Gmail's `?access_token=` — the SDK uses the header.
  return new URL(req.url).searchParams.get("access_token") || undefined;
}

/**
 * Validate the bearer access token. Returns the token row on success, or a
 * Gmail-shaped 401 to return as-is. Shared by `checkAuth` and `handleGmail`.
 */
export function authenticate(req: Request, db: Database): TokenRow | NextResponse {
  const result = validateAccessToken(db, extractToken(req));
  if (!result.ok) return unauthorized();
  return result.token;
}

/**
 * Back-compat auth-only check. Returns null if authorized, or a 401 NextResponse.
 * Retained for `history.list`, which does not go through `handleGmail` (it 501s
 * regardless) but must still reject an invalid token.
 */
export function checkAuth(req: Request): NextResponse | null {
  const result = authenticate(req, getDb());
  return result instanceof NextResponse ? result : null;
}

/** True if the token's granted scopes satisfy the single required scope. */
export function tokenHasScope(token: TokenRow, required: string): boolean {
  return hasScope(token.scope, required);
}

/** Google's shape for a valid token that lacks the scope a route requires. */
export function insufficientScope(): NextResponse {
  return errorResponse(
    403,
    "Request had insufficient authentication scopes.",
    "insufficientPermissions",
    "PERMISSION_DENIED",
  );
}
