import { unauthorized, errorResponse } from "./errors";
import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { getDb } from "../db";
import { safeEqual, validateAccessToken } from "../oauth/service";
import { GMAIL_SCOPE, hasScope } from "../oauth/scopes";
import type { TokenRow } from "../oauth/store";

// Auth for /gmail/v1/*, in two modes.
//
// `token` (the default): the static bearer below works with full scope — the
// zero-setup path for a local fixture. OAuth tokens minted by the sandbox's own
// authorization server work too; the flow is always mounted and can be exercised
// without flipping the mode.
//
// `oauth` (SANDBOX_AUTH=oauth): only OAuth tokens are accepted, per-route scopes
// enforced — the agent passes an OAuth2Client whose access_token becomes an
// `Authorization: Bearer` header, exactly as against real Gmail. The static
// token is refused here; it stays the control-plane admin credential either way
// (/api/sandbox/*, see ../sandbox/auth.ts).
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

export type AuthMode = "token" | "oauth";

// A live override for demos, settable from the dashboard through the admin-gated
// POST /api/sandbox/auth-mode. Process memory only, on globalThis so Next HMR
// keeps it: SANDBOX_AUTH stays the durable setting, and a restart falls back to
// it. Deliberately not persisted anywhere — one setting, one home.
const g = globalThis as { __sandboxAuthMode?: AuthMode };

/** Anything but an explicit "oauth" is `token` — a typo must not lock anyone out. */
export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  return g.__sandboxAuthMode ?? (env.SANDBOX_AUTH === "oauth" ? "oauth" : "token");
}

/** Flip the live mode; `null` clears the override back to the env setting. */
export function setAuthMode(mode: AuthMode | null): void {
  if (mode === null) delete g.__sandboxAuthMode;
  else g.__sandboxAuthMode = mode;
}

/** The static token's standing in `token` mode: valid for everything, forever. */
function staticTokenRow(): TokenRow {
  return {
    access_token: SANDBOX_TOKEN,
    refresh_token: null,
    client_id: "sandbox-static",
    scope: GMAIL_SCOPE.full,
    access_token_expires_at: Number.MAX_SAFE_INTEGER,
    refresh_token_expires_at: null,
    revoked_at: null,
    created_at: 0,
  };
}

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
export function authenticate(
  req: Request,
  db: Database,
  mode: AuthMode = authMode(),
): TokenRow | NextResponse {
  const bearer = extractToken(req);
  const result = validateAccessToken(db, bearer);
  if (result.ok) return result.token;
  if (mode === "token" && safeEqual(bearer, SANDBOX_TOKEN)) return staticTokenRow();
  return unauthorized();
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
