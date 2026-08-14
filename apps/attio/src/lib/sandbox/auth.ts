import { NextResponse } from "next/server";
import { SANDBOX_TOKEN } from "../attio/auth";

// Token gate for /api/sandbox/*. The same static token as /v2/*, so the engine
// carries one credential per twin — but the failure is a plain sandbox error and
// not an Attio API error: these routes are machinery, and dressing them up as
// Attio would teach an agent that stumbled onto them the wrong thing.

/** Returns null when authorized, or a 401 to return as-is. */
export function requireSandboxToken(req: Request): NextResponse | null {
  // All three spellings, and not out of caution: the engine sends both headers
  // on every control-plane call, so accepting only one works with some callers
  // and 401s with others.
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token =
    req.headers.get("x-sandbox-token") ||
    m?.[1] ||
    new URL(req.url).searchParams.get("access_token");
  if (token !== SANDBOX_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", detail: "send X-Sandbox-Token or a bearer token" },
      { status: 401 },
    );
  }
  return null;
}

/** Uniform failure shape for the sandbox routes: `{ ok: false, error }`. */
export function sandboxError(err: unknown, status = 500): NextResponse {
  return NextResponse.json(
    { ok: false, error: err instanceof Error ? err.message : String(err) },
    { status },
  );
}

/** Thrown for anything the caller can fix; the routes turn it into a 400. */
export class BadRequestError extends Error {}
