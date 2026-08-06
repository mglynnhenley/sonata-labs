import { NextResponse } from "next/server";
import { runExecution } from "@sonata/core";
import { judgeRun } from "@/lib/engine/verdict";
import { isModelId } from "@/lib/models";
import { readRun, readSpec } from "../../../../results/_lib/artifacts";

// Re-judge a saved run with a different model. Nothing is re-run: the day on
// disk is read again, so the only thing that can change is the judge's half of
// the verdict — the findings and the diagnosis, not the deterministic score.
//
// The work is `judgeRun`, the same function the engine judges a day with when it
// ends. It writes `<runId>.judge.json`, folds the report into the run artifact
// AND moves the relational row Home reads. Calling the judge from here and
// writing back by hand is how this button used to leave the two pages quoting
// different numbers for the same run.

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
  if (run.status === "queued" || run.status === "running") {
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
      { error: `There is nothing for a judge to read. ${execution.reason ?? ""}`.trim() },
      { status: 400 },
    );
  }

  try {
    const { report, autonomy, spend } = await judgeRun(run, readSpec(runId), {
      ...(model ? { model } : {}),
      signal: req.signal,
      // Somebody pressed a button. Every other caller of `judgeRun` is a day
      // ending, and the page says which of the two it is looking at.
      manual: true,
    });
    return NextResponse.json({ report, autonomy, spend });
  } catch (err) {
    // The message is shown verbatim in the dialog, so it has to say what to do
    // next: a missing key, a bad slug and a timeout are all recoverable.
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
