import { AssessmentBusyError } from "@/lib/engine/assessments";
import { CloneBusyError } from "@/lib/engine/cloneLease";
import { NextResponse } from "next/server";
import { runExecution } from "@sonata/core";
import { judgeRun } from "@/lib/engine/verdict";
import { isModelId } from "@/lib/models";
import { readRun, readSpec } from "../../../../results/_lib/artifacts";
import { getRun as liveRun } from "../../../_lib/runner";

// Assess the saved day through the same Inspect scorer used at run completion.
// Each attempt has its own record; only the latest successful display copy moves.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A judge pass on a full day is minutes, not seconds. */
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) return NextResponse.json({ error: "No run with that id." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { model?: unknown };
  const model = typeof body.model === "string" ? body.model.trim() : "";

  if (model && !isModelId(model)) {
    return NextResponse.json(
      { error: `"${model}" is not an OpenRouter slug. They look like provider/model-name.` },
      { status: 400 },
    );
  }

  // Judging a day that is still being written would score a fragment at full
  // price, and the write-back would race the engine still appending ticks.
  if (["queued", "running", "judging"].includes(liveRun(runId)?.status ?? run.status)) {
    return NextResponse.json(
      { error: "This run is still going. Let the day finish, then judge it." },
      { status: 409 },
    );
  }

  // The same bar `scoreRun` uses, checked before the money is spent: a run the
  // agent never worked has nothing in it for a judge to read, and a diagnosis of
  // nothing would be quoted as a finding about a model.
  const execution = runExecution(run);
  if (!execution.executed) {
    return NextResponse.json(
      { error: `This run cannot be assessed. ${execution.reason ?? ""}`.trim() },
      { status: 400 },
    );
  }

  try {
    const { assessment, report, autonomy, spend } = await judgeRun(run, readSpec(runId), {
      ...(model ? { model } : {}),
      signal: req.signal,
      // Somebody pressed a button. Every other caller of `judgeRun` is a day
      // ending, and the page says which of the two it is looking at.
      manual: true,
    });
    return NextResponse.json({ assessmentId: assessment.id, report, autonomy, spend });
  } catch (err) {
    // The message is shown verbatim in the dialog, so it has to say what to do
    // next: a missing key, a bad slug and a timeout are all recoverable.
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof AssessmentBusyError || err instanceof CloneBusyError ? 409 : 502 });
  }
}
