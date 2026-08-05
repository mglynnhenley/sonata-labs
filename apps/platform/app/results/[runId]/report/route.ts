import { NextResponse, type NextRequest } from "next/server";

// The report moved with its run: /runs/{id}/report is the address now.
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return NextResponse.redirect(
    new URL(`/runs/${encodeURIComponent(runId)}/report`, request.url),
    308,
  );
}
