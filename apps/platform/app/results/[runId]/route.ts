import { NextResponse, type NextRequest } from "next/server";

// One run, one URL: /runs/{id} serves live and finished. Deep links with
// anchors (#failures, #replay…) survive — the browser carries the fragment
// across the redirect and the anchor names are unchanged.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return NextResponse.redirect(new URL(`/runs/${encodeURIComponent(runId)}`, request.url), 308);
}
