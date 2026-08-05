import { NextResponse } from "next/server";
import { listSessions, startSession, sweepOrphanSessions } from "@/lib/engine/session";
import type { StartSessionInput } from "./_lib/types";

// Sessions: the world running at an agent nobody here is driving.
//
// A run is started, driven and scored by this process. A session is started
// here and then plays on a wall-clock timer while the agent works against the
// twins from wherever it lives — so these two routes are the whole control
// surface, and everything else is read back out of the twins' audit logs.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    // A session is a timer in memory; a restart takes it. Sweep before listing,
    // so a row can never sit at "running" with a clock that stopped moving.
    sweepOrphanSessions();
    // `at` is the server's clock: every countdown to the next tick is measured
    // against it, so the first paint and the first client render agree.
    return NextResponse.json({ sessions: listSessions(), at: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<StartSessionInput>;
    if (!body.episodeId) {
      return NextResponse.json({ error: "Pick a scenario for the day." }, { status: 400 });
    }

    const view = startSession({
      episodeId: body.episodeId,
      compression: body.compression ?? 60,
      ...(body.agentLabel ? { agentLabel: body.agentLabel } : {}),
      ...(body.twins ? { twins: body.twins } : {}),
      ...(body.ticks === undefined ? {} : { ticks: body.ticks }),
      ...(body.seedWorld === undefined ? {} : { seedWorld: body.seedWorld }),
      ...(body.judge === undefined ? {} : { judge: body.judge }),
    });
    return NextResponse.json({ session: view }, { status: 201 });
  } catch (err) {
    // Bad request, not a server fault: what fails here is a scenario that does
    // not resolve, and the message names the ones that do.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
