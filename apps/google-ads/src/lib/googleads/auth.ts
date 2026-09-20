import { authError, requestError } from "./errors";
import type { GoogleAdsError } from "./errors";

// The provider gate for /v*/…. Static bearer token: the sandbox is not
// protecting real data, it exists so that the auth path an agent copies out of
// Google's REST examples works unchanged.
//
// This file does NOT hold the control-plane gate — that lives in
// src/lib/sandbox/auth.ts and answers in plain JSON, because /api/sandbox/* is
// machinery an agent must not learn from.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return new URL(req.url).searchParams.get("access_token") || undefined;
}

/**
 * Returns the error to throw, or null when the caller is authorized.
 *
 * The developer-token header's PRESENCE is required and its VALUE is not
 * checked. The sandbox is not an approval gate, so checking the value would be
 * theatre — but its absence is the one thing that makes Google Ads' auth
 * different from every other Google API, and an agent that learned "a bearer is
 * enough" from the Gmail twin should find that out here rather than silently get
 * data back.
 *
 * A missing developer-token is a 400 `requestError: DEVELOPER_TOKEN_PARAMETER_MISSING`
 * and NOT a 401, which reads backwards until you check the enums: that code lives
 * in RequestError, because an absent header is a malformed request rather than a
 * failed identity. A bad bearer is the 401 — `AuthenticationError` is where
 * OAUTH_TOKEN_INVALID lives, and it has no ..._PARAMETER_MISSING member at all.
 *
 * `login-customer-id` is read by the real API to pick which manager account the
 * call runs under. The sandbox holds one account, so there is nothing to
 * impersonate and it is accepted and ignored — rejecting it would break a caller
 * who is doing everything right.
 */
export function checkAuth(req: Request): GoogleAdsError | null {
  const developerToken = req.headers.get("developer-token");
  if (!developerToken || !developerToken.trim()) {
    return requestError("DEVELOPER_TOKEN_PARAMETER_MISSING", "developer-token parameter is missing.");
  }
  if (bearerToken(req) !== SANDBOX_TOKEN) {
    return authError("OAUTH_TOKEN_INVALID", "OAuth access token in the header is not valid.");
  }
  return null;
}
