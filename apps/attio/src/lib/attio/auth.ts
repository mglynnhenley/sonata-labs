import type { NextResponse } from "next/server";
import { unauthorizedResponse } from "./errors";

// The provider gate, and the only home for the provider credential.
//
// Attio authenticates with a Bearer API key and nothing else, so unlike the
// Gmail twin there is no OAuth mode, no token endpoint and no authorization
// server: the control-plane token and the API key are the same string, and the
// only difference between the two surfaces is the shape of the failure. The
// control-plane gate lives in src/lib/sandbox/auth.ts and imports the token
// from here, so there is one credential per twin.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/**
 * The API key's own identity, which GET /v2/self reports as `client_id` and
 * `aud`. A constant rather than a meta row because it is a property of the
 * credential, not of the seeded world — re-seeding must not change who the key
 * belongs to.
 */
export const API_CLIENT_ID = "aa6d3e7f-80af-4d77-8b48-22629a07651c";

/** The scope string GET /v2/self reports, in Attio's own vocabulary. */
export const API_SCOPE =
  "record_permission:read-write object_configuration:read note:read-write task:read-write user_management:read";

/**
 * Writes that arrive over the API are stamped with an api-token actor, which is
 * what real Attio does for an API-key write and what keeps a stage the agent
 * moved distinguishable — in the response itself, not just in a column the API
 * never returns — from a stage the world seeded.
 */
export const API_TOKEN_ACTOR = { type: "api-token", id: API_CLIENT_ID } as const;

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return new URL(req.url).searchParams.get("access_token") || undefined;
}

/** Returns null when authorized, or Attio's 401 to return as-is. */
export function checkAuth(req: Request): NextResponse | null {
  return bearerToken(req) === SANDBOX_TOKEN ? null : unauthorizedResponse();
}
