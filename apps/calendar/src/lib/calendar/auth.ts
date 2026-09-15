import { unauthorized } from "./errors";
import type { NextResponse } from "next/server";
import { authorizedControlRequest } from "@sonata/core/controlAuth";

// Static bearer token auth for /calendar/v3/*. The sandbox isn't protecting
// real data — it exists so the official SDK's auth path works unchanged (agents
// pass an OAuth2Client whose access_token becomes an Authorization: Bearer
// header).
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
 * Returns null if authorized, or a 401 NextResponse if not.
 * Accepts `Authorization: Bearer <token>` (what the SDK sends via
 * OAuth2Client.setCredentials) and, as a convenience, `?access_token=`.
 */
export function checkAuth(req: Request): NextResponse | null {
  return bearerToken(req) === SANDBOX_TOKEN ? null : unauthorized();
}

/**
 * Gate for /api/sandbox/* — the control surface that can rewrite the world.
 * Not part of the Google API surface, so it answers in plain JSON rather than
 * Google's envelope. A per-workplace SANDBOX_CONTROL_TOKEN is separate from the
 * provider bearer; shared developer apps fall back to their existing token.
 */
export function checkSandboxToken(req: Request): Response | null {
  if (authorizedControlRequest(req)) return null;
  return Response.json(
    { ok: false, error: "unauthorized", detail: "send X-Sandbox-Token or a bearer token" },
    { status: 401 },
  );
}
