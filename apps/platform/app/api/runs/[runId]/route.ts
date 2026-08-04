import { NextResponse } from "next/server";
import {
  abortRun,
  getRun,
  pauseRun,
  resumeInterruptedRuns,
  resumeRun,
  toDetail,
  toSummary,
} from "../../_lib/runner";
import type { RunCommand } from "../../_lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The live channel for a running day. Polling, not SSE: a tick is a whole
// paragraph of state and arrives once a second at most, so a plain GET with a
// watermark is simpler, survives a dropped connection, and needs no reconnect
// logic in the browser.
//
//   GET ?sinceTick=12  → only the ticks the caller has not seen
//   GET ?full=1        → the whole run, for a first paint or a replay

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    resumeInterruptedRuns();

    const doc = getRun(runId);
    if (!doc) return NextResponse.json({ error: "No such run" }, { status: 404 });

    const url = new URL(req.url);
    if (url.searchParams.get("full") === "1") {
      return NextResponse.json({ run: toDetail(doc) });
    }

    const sinceTick = Math.max(0, Number(url.searchParams.get("sinceTick") ?? 0) || 0);
    const ticks = doc.ticks.filter((tick) => tick.tick >= sinceTick);
    return NextResponse.json({
      run: toSummary(doc),
      ticks,
      nextSinceTick: doc.tickCount,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const body = (await req.json().catch(() => ({}))) as { command?: RunCommand };

    const doc =
      body.command === "pause"
        ? pauseRun(runId)
        : body.command === "resume"
          ? resumeRun(runId)
          : body.command === "abort"
            ? abortRun(runId)
            : undefined;

    if (!doc) {
      return NextResponse.json(
        { error: body.command ? "No such run" : "Say what to do: pause, resume or abort." },
        { status: body.command ? 404 : 400 },
      );
    }
    return NextResponse.json({ run: toSummary(doc) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
