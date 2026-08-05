import { NextResponse } from "next/server";
import { sessionStatus, stopSession, sweepOrphanSessions } from "@/lib/engine/session";

// The live channel for a session in progress.
//
// Polling with a watermark, the same as a run's: a tick is a paragraph of state
// and at the default compression it lands every fifteen seconds, so a plain GET
// asking for "everything after tick N" is simpler than SSE, survives a dropped
// connection with no reconnect logic, and makes a browser refresh cost nothing.
//
//   GET ?sinceTick=12  → the ticks the caller has not seen, plus where the day is
//   DELETE             → stop the day; it is scored and filed on the way out

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    sweepOrphanSessions();

    const sinceTick = Math.max(0, Number(new URL(req.url).searchParams.get("sinceTick") ?? 0) || 0);
    const poll = sessionStatus(sessionId, sinceTick);
    if (!poll) return NextResponse.json({ error: "No session with that id." }, { status: 404 });
    return NextResponse.json(poll);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const view = await stopSession(sessionId, body.reason);
    if (!view) return NextResponse.json({ error: "No session with that id." }, { status: 404 });
    return NextResponse.json({ session: view });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
