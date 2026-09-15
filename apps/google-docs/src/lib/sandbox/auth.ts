import { NextResponse } from "next/server";
import { authorizedControlRequest } from "@sonata/core/controlAuth";

// Control routes use the harness credential; provider API auth stays separate.
/** Returns null when authorized, or a 401 to return as-is. */
export function requireSandboxToken(req: Request): NextResponse | null {
  if (!authorizedControlRequest(req)) {
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
