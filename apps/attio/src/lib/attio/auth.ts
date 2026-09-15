import type { NextResponse } from "next/server";
import { unauthorizedResponse } from "./errors";

// The provider gate, and the only home for the provider credential.
//
// Attio's provider API uses SANDBOX_TOKEN. The harness control plane resolves
// its independent credential in src/lib/sandbox/auth.ts.
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
