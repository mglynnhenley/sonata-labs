import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { assessmentDir, readAssessment } from "@/lib/engine/assessments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: {
  params: Promise<{ runId: string; assessmentId: string }>;
}) {
  const { runId, assessmentId } = await params;
  if (![runId, assessmentId].every(id => /^[\w-]+$/.test(id))) {
    return NextResponse.json({ error: "Invalid identifier." }, { status: 400 });
  }
  const record = readAssessment(runId, assessmentId);
  if (!record) return NextResponse.json({ error: "Assessment not found." }, { status: 404 });
  if (new URL(req.url).searchParams.get("format") !== "inspect") return NextResponse.json(record);
  if (!record.log || record.log !== path.basename(record.log) || !record.log.endsWith(".eval")) {
    return NextResponse.json({ error: "No Inspect log was captured for this assessment." }, { status: 404 });
  }
  return new Response(readFileSync(path.join(assessmentDir(runId, assessmentId), record.log)), {
    headers: { "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${assessmentId}.eval"` },
  });
}
