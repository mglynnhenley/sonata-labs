import { NextResponse } from "next/server";
import { readBrief, readRun, readTrace } from "../../../results/_lib/artifacts";
import { costBreakdown } from "../../../results/_lib/cost";
import { summarizeRun } from "../../../results/_lib/summary";

// One run, as the results page sees it. The trace is projected into the cost
// breakdown rather than returned: it holds verbatim provider bodies and would be
// megabytes on the wire. `GET /api/results/[runId]/trace` is deliberately not a
// route — the artifact is on disk if you need it raw.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) return NextResponse.json({ error: "No run with that id." }, { status: 404 });

  return NextResponse.json({
    run,
    summary: summarizeRun(run),
    brief: readBrief(runId),
    cost: costBreakdown(readTrace(runId), run.verdict?.cost ?? null),
  });
}
