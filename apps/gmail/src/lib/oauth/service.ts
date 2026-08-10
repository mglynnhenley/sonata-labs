import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  getAuthCode,
  getClient,
  getTokenByAccess,
  getTokenByRefresh,
  insertAuthCode,
  insertToken,
  markAuthCodeUsed,
  redirectUris,
  type TokenRow,
} from "./store";
import { verifyPkce } from "./pkce";
import { serializeScopes } from "./scopes";

// Policy layer: the actual OAuth2 rules. store.ts is rows; this is the flow.

export const CODE_TTL_MS = 60_000; // authorization codes are short-lived (~60s)
export const ACCESS_TTL_MS = 3_600_000; // access tokens live 1h, like Google's
export const ACCESS_TTL_SEC = ACCESS_TTL_MS / 1000;

/** Opaque, URL-safe token. 32 bytes ≈ 43 base64url chars. */
function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- authorization code issuance (called from the consent decision) ----------

export interface IssueCodeParams {
  clientId: string;
  redirectUri: string;
  scope: string; // space-delimited, already validated/granted
  codeChallenge: string;
  codeChallengeMethod: string; // "S256"
  now?: number;
}

export function issueAuthorizationCode(db: Database, p: IssueCodeParams): string {
  const now = p.now ?? Date.now();
  const code = randomToken("code_");
  insertAuthCode(db, {
    code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    expires_at: now + CODE_TTL_MS,
    used_at: null,
  });
  return code;
}

// --- token endpoint grants ---------------------------------------------------

export interface TokenGrant {
  access_token: string;
  refresh_token: string | null;
  scope: string;
  expires_in: number;
  token_type: "Bearer";
}

export type TokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_scope";

export type GrantResult =
  | { ok: true; grant: TokenGrant }
  | { ok: false; error: TokenErrorCode; description: string; status: number };

function fail(error: TokenErrorCode, description: string, status = 400): GrantResult {
  return { ok: false, error, description, status };
}

/** Confidential clients must present a matching secret at the token endpoint. */
function checkClientSecret(
  db: Database,
  clientId: string,
  clientSecret: string | undefined,
): GrantResult | null {
  const client = getClient(db, clientId);
  if (!client) return fail("invalid_client", "Unknown client.", 401);
  if (client.confidential) {
    if (!safeEqual(client.client_secret, clientSecret ?? null)) {
      return fail("invalid_client", "Client authentication failed.", 401);
    }
  }
  return null;
}

function issueTokenRow(
  db: Database,
  clientId: string,
  scope: string,
  now: number,
  withRefresh: boolean,
): TokenGrant {
  const access = randomToken("ya29_");
  const refresh = withRefresh ? randomToken("1__") : null;
  const row: TokenRow = {
    access_token: access,
    refresh_token: refresh,
    client_id: clientId,
    scope,
    access_token_expires_at: now + ACCESS_TTL_MS,
    refresh_token_expires_at: null, // refresh tokens do not expire (Google-like)
    revoked_at: null,
    created_at: now,
  };
  insertToken(db, row);
  return {
    access_token: access,
    refresh_token: refresh,
    scope,
    expires_in: ACCESS_TTL_SEC,
    token_type: "Bearer",
  };
}

export interface AuthCodeGrantParams {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  now?: number;
}

export function grantAuthorizationCode(db: Database, p: AuthCodeGrantParams): GrantResult {
  const now = p.now ?? Date.now();
  if (!p.code) return fail("invalid_request", "Missing 'code'.");

  const secretErr = checkClientSecret(db, p.clientId, p.clientSecret);
  if (secretErr) return secretErr;

  const codeRow = getAuthCode(db, p.code);
  if (!codeRow) return fail("invalid_grant", "Authorization code not found.");
  if (codeRow.client_id !== p.clientId)
    return fail("invalid_grant", "Authorization code was issued to another client.");
  if (codeRow.redirect_uri !== p.redirectUri)
    return fail("invalid_grant", "redirect_uri does not match the authorization request.");
  if (codeRow.used_at != null) return fail("invalid_grant", "Authorization code already used.");
  if (now > codeRow.expires_at) return fail("invalid_grant", "Authorization code expired.");

  // PKCE is mandatory: every code carries an S256 challenge.
  if (!p.codeVerifier) return fail("invalid_request", "Missing PKCE 'code_verifier'.");
  if (!verifyPkce(p.codeVerifier, codeRow.code_challenge))
    return fail("invalid_grant", "PKCE verification failed.");

  // Single-use: the atomic guard wins any race; a loser sees it as already-used.
  if (!markAuthCodeUsed(db, p.code, now))
    return fail("invalid_grant", "Authorization code already used.");

  return { ok: true, grant: issueTokenRow(db, p.clientId, codeRow.scope, now, true) };
}

export interface RefreshGrantParams {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scope?: string; // optional narrowing; must be a subset of the original grant
  now?: number;
}

export function grantRefreshToken(db: Database, p: RefreshGrantParams): GrantResult {
  const now = p.now ?? Date.now();
  if (!p.refreshToken) return fail("invalid_request", "Missing 'refresh_token'.");

  const secretErr = checkClientSecret(db, p.clientId, p.clientSecret);
  if (secretErr) return secretErr;

  const existing = getTokenByRefresh(db, p.refreshToken);
  if (!existing) return fail("invalid_grant", "Refresh token not found.");
  if (existing.client_id !== p.clientId)
    return fail("invalid_grant", "Refresh token was issued to another client.");
  if (existing.revoked_at != null) return fail("invalid_grant", "Refresh token revoked.");
  if (existing.refresh_token_expires_at != null && now > existing.refresh_token_expires_at)
    return fail("invalid_grant", "Refresh token expired.");

  // Narrowing only: a refresh may request a subset of the original scopes.
  let scope = existing.scope;
  if (p.scope) {
    const original = new Set(existing.scope.split(/\s+/).filter(Boolean));
    const requested = p.scope.split(/\s+/).filter(Boolean);
    if (!requested.every((s) => original.has(s)))
      return fail("invalid_scope", "Requested scope exceeds the original grant.");
    scope = serializeScopes(requested);
  }

  // Mint a fresh access token; reuse the same refresh token (Google does not
  // rotate refresh tokens on a standard refresh).
  const access = randomToken("ya29_");
  insertToken(db, {
    access_token: access,
    refresh_token: null, // the refresh token stays on the original row
    client_id: p.clientId,
    scope,
    access_token_expires_at: now + ACCESS_TTL_MS,
    refresh_token_expires_at: null,
    revoked_at: null,
    created_at: now,
  });
  return {
    ok: true,
    grant: {
      access_token: access,
      refresh_token: p.refreshToken,
      scope,
      expires_in: ACCESS_TTL_SEC,
      token_type: "Bearer",
    },
  };
}

// --- access-token validation (used by checkAuth) -----------------------------

export type ValidateResult =
  | { ok: true; token: TokenRow }
  | { ok: false; reason: "missing" | "unknown" | "expired" | "revoked" };

export function validateAccessToken(db: Database, accessToken: string | undefined, now = Date.now()): ValidateResult {
  if (!accessToken) return { ok: false, reason: "missing" };
  const row = getTokenByAccess(db, accessToken);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at != null) return { ok: false, reason: "revoked" };
  if (now > row.access_token_expires_at) return { ok: false, reason: "expired" };
  return { ok: true, token: row };
}

// --- admin mint (the /api/sandbox/token bridge for the harness) --------------

/**
 * Programmatically mint an access token for a client + scope set, bypassing the
 * interactive flow. Admin-gated at the route; used by the benchmark harness and
 * offered as an ergonomic shortcut for agent developers who do not want to click
 * through consent. Returns a full token grant (with a refresh token).
 */
export function mintToken(
  db: Database,
  params: { clientId: string; scope: string; now?: number },
): TokenGrant {
  const now = params.now ?? Date.now();
  return issueTokenRow(db, params.clientId, params.scope, now, true);
}
