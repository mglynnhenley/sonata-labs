import { NextResponse } from "next/server";
import { sessionStatus, sweepOrphanSessions } from "@/lib/engine/session";
import { readRun } from "../../../../results/_lib/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read captured assessment only; never starts a run or another judge call. */
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    sweepOrphanSessions();
    const poll = sessionStatus(sessionId);
    if (!poll) return NextResponse.json({ error: "No session with that id." }, { status: 404 });
    const { session } = poll;
    if (session.live || ["queued", "running", "judging"].includes(session.status)) {
      return NextResponse.json({ error: "The session has not finished capturing its result.", session }, { status: 409 });
    }
    return NextResponse.json({ session, run: readRun(sessionId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
