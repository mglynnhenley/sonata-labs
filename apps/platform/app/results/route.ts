import { NextResponse, type NextRequest } from "next/server";

// /results is gone: the run list lives at /runs and the benchmark at /compare.
// A route handler rather than a page, so the 308 is a real status line — the
// article pulls these URLs with curl, and a streamed meta-refresh is not a
// redirect to anything that is not a browser.
export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/compare", request.url), 308);
}
