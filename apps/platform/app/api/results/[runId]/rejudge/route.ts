import { NextResponse } from "next/server";
import { isModelId } from "@/lib/models";
import { readBrief, readRun, updateRunJudge } from "../../../../results/_lib/artifacts";
import { rejudgeRun } from "../../_lib/rejudge";

// Re-judge a saved run with a different model. Nothing is re-run: the day on
// disk is read again, so the only thing that can change is the judge's half of
// the verdict — the findings, and the autonomy score derived from them.

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

  if (run.ticks.length === 0) {
    return NextResponse.json(
      { error: "This run recorded no ticks, so there is nothing for a judge to read." },
      { status: 400 },
    );
  }

  // Judging a day that is still being written would score a fragment at full
  // price, and the write-back would race the engine still appending ticks.
  if (run.status === "queued" || run.status === "running") {
    return NextResponse.json(
      { error: "This run is still going. Let the day finish, then judge it." },
      { status: 409 },
    );
  }

  try {
    const report = await rejudgeRun(run, readBrief(runId), {
      ...(model ? { model } : {}),
      signal: req.signal,
    });
    const verdict = updateRunJudge(runId, report);
    if (!verdict) {
      return NextResponse.json(
        { error: "The judge ran, but the artifact could not be written back." },
        { status: 500 },
      );
    }
    return NextResponse.json({ report, autonomy: verdict.autonomy });
  } catch (err) {
    // The message is shown verbatim in the dialog, so it has to say what to do
    // next: a missing key, a bad slug and a timeout are all recoverable.
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
