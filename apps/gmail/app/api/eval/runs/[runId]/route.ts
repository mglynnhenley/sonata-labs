import { requireSandboxToken } from "@/lib/sandbox/auth";
import { NextResponse } from "next/server";
import { getReport } from "@/lib/eval/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const authErr = requireSandboxToken(req);
  if (authErr) return authErr;
  try {
    const { runId } = await params;
    const report = getReport(runId);
    if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
