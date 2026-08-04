import { NextResponse } from "next/server";
import { SANDBOX_TOKEN } from "../gmail/auth";

// Token gate for /api/sandbox/*. Same static token as /gmail/v1/*, so the engine
// carries one credential per twin — but the failure is a plain sandbox error and
// not a Gmail API error: these routes are machinery, and dressing them up as
// Gmail would teach an agent that stumbled onto them the wrong thing.

/** Returns null when authorized, or a 401 to return as-is. */
export function requireSandboxToken(req: Request): NextResponse | null {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1] ?? new URL(req.url).searchParams.get("access_token");
  if (token !== SANDBOX_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
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
