import { NextResponse } from "next/server";

// The Slack error model — and the linchpin of SDK compatibility. Slack returns
// HTTP 200 for API errors: `{ok:false, error:"channel_not_found"}`. The
// @slack/web-api SDK throws a PlatformError reading `.data.error`; it never
// looks at the HTTP status for API-level failures. Every route returns through
// ok()/err() so the envelope is always exactly right.

export function ok(data: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, ...data });
}

export function err(error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, error, ...extra });
}

/** Throwable error carrying a documented Slack error code string. */
export class SlackError extends Error {
  code: string;
  extra?: Record<string, unknown>;

  constructor(code: string, extra?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

/** Translate a thrown SlackError (or any error) into an envelope response. */
export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof SlackError) return err(e.code, e.extra);
  const message = e instanceof Error ? e.message : String(e);
  // Slack's catch-all for server faults; still HTTP 200 + envelope.
  return err("internal_error", { detail: message });
}

/**
 * The one place Slack does NOT use HTTP 200: rate limits are a real 429 with a
 * Retry-After header. The SDK reads the header to schedule its own retry, so
 * getting this shape right is what makes resilience testing meaningful.
 */
export function rateLimited(retryAfterSec: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: "ratelimited" },
    { status: 429, headers: { "retry-after": String(retryAfterSec) } },
  );
}
