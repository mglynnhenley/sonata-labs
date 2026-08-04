import { NextResponse } from "next/server";
import { listRuns } from "@/lib/eval/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Run list for the trace viewer, newest first.
export function GET() {
  try {
    return NextResponse.json({ runs: listRuns() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
