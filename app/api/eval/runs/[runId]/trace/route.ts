import { NextResponse } from "next/server";
import { getTrace } from "@/lib/eval/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Served separately from the report: traces are much larger, and the run list
// never needs them.
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const trace = getTrace(runId);
    if (!trace) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(trace);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
