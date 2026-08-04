import { notFound } from "next/navigation";
import { readBrief, readRun, readTrace } from "../_lib/artifacts";
import { costBreakdown } from "../_lib/cost";
import { RunDetail } from "./RunDetail";

// Artifacts are appended to while a run is going, so this page is never cached.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  return { title: run ? `${run.specTitle} · ${run.model}` : "Run not found" };
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) notFound();

  // The trace stays on the server: it carries verbatim provider bodies and runs
  // to megabytes. Only the projection the cost section needs crosses the wire.
  const cost = costBreakdown(readTrace(runId), run.verdict?.cost ?? null);

  return <RunDetail run={run} brief={readBrief(runId)} cost={cost} />;
}
