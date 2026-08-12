import { NextResponse } from "next/server";
import { SANDBOX_TOKEN } from "../linkedin/auth";

// Token gate for /api/sandbox/*. Same static token as /rest/* and /v2/*, so the
// engine carries one credential per twin — but the failure is a plain sandbox
// error and NOT a LinkedIn API error: these routes are machinery, and dressing
// them up as LinkedIn would teach an agent that stumbled onto them the wrong
// thing.

/** Returns null when authorized, or a 401 to return as-is. */
export function requireSandboxToken(req: Request): NextResponse | null {
  // All three spellings, because the orchestrator sends both header forms on
  // every control-plane call and accepting only one works with some callers and
  // 401s with others — which is the least useful failure this can produce.
  const header = req.headers.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const token =
    req.headers.get("x-sandbox-token") ??
    bearer ??
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
