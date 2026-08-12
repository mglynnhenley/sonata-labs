import { NextResponse } from "next/server";
import { ApiError } from "./api-client";

// Translate a BFF error into a response. An upstream API error passes through
// with its status so the browser sees the real cause — including the 401 a
// sessionless request earns when the API is in oauth mode.
export function bffError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: "upstream_error", detail: err.body.slice(0, 300) }, { status: err.status });
  }
  return NextResponse.json({ error: (err as Error).message ?? "error" }, { status: 500 });
}
