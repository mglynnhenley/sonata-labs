import { NextResponse } from "next/server";
import { runExecution } from "@sonata/core";
import { readRun } from "../../../../results/_lib/artifacts";
import { judgeState, readJudgeAttempt } from "../../_lib/judgeAttempt";

// Where this run's diagnosis has got to: being read, read, or not readable and
// why. The report itself already comes down with the run — this is the thin
// channel the sections on the page use to say which of those three they are
// looking at, and to poll while a pass is in flight.
//
// Cheap on purpose: an attempt record is a few hundred bytes, so a page with
// four sections asking about it costs nothing next to the artifact they are
// already rendering.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) return NextResponse.json({ error: "No run with that id." }, { status: 404 });

  const report = run.verdict?.judge ?? null;
  const execution = runExecution(run);
  return NextResponse.json(
    judgeState({
      judged: report ? { model: report.model, judgedAt: report.judgedAt } : null,
      attempt: readJudgeAttempt(runId),
      // A day the agent never worked is not un-judged, it is un-judgeable — and
      // the reason is the same sentence the score gives for having no verdict.
      nothingToRead: execution.executed ? null : (execution.reason ?? null),
    }),
  );
}
