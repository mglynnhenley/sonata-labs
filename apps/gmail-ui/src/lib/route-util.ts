import { NextResponse } from "next/server";
import { NoSessionError, ApiError } from "./api-client";

// Translate a BFF error into a response. A missing session becomes a 401 (the
// page-level guard sends the user through the OAuth flow); an upstream API error
// is passed through with its status so the browser sees the real cause.
export function bffError(err: unknown): NextResponse {
  if (err instanceof NoSessionError) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (err instanceof ApiError) {
    return NextResponse.json({ error: "upstream_error", detail: err.body.slice(0, 300) }, { status: err.status });
  }
  return NextResponse.json({ error: (err as Error).message ?? "error" }, { status: 500 });
}
