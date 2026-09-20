import { requireSandboxToken } from "@/lib/sandbox/auth";
import { NextResponse } from "next/server";
import { getJudge } from "@/lib/eval/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Its own route because a run is judged separately from being run: an artifact
// exists long before it has a judge, and 404 here means "not judged yet", not
// "no such run".
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const authErr = requireSandboxToken(req);
  if (authErr) return authErr;
  try {
    const { runId } = await params;
    const judge = getJudge(runId);
    if (!judge) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(judge);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
