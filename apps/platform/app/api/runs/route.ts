import { NextResponse } from "next/server";
import { activeRun, listRuns, resumeInterruptedRuns, startRun } from "../_lib/runner";
import type { StartRunInput } from "../_lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    resumeInterruptedRuns();
    const active = activeRun();
    // `at` is the server's clock. Every "4 min ago" in the runs list is measured
    // against it, so the first server paint and the first client render agree.
    return NextResponse.json({
      runs: listRuns(),
      activeRunId: active?.runId ?? null,
      at: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<StartRunInput>;
    if (!body.episodeId) {
      return NextResponse.json({ error: "Pick a scenario to run." }, { status: 400 });
    }
    if (!body.model) {
      return NextResponse.json({ error: "Pick the model that will play the agent." }, { status: 400 });
    }

    const doc = startRun({
      episodeId: body.episodeId,
      model: body.model,
      twins: body.twins ?? [],
      ticks: body.ticks ?? 24,
    });
    return NextResponse.json({ runId: doc.runId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
