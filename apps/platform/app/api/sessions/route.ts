import { NextResponse } from "next/server";
import { listSessions, sessionLaunch, startSession, sweepOrphanSessions } from "@/lib/engine/session";
import { normalizeSessionTiming, TWIN_NAMES } from "@sonata/core";
import type { StartSessionInput } from "./_lib/types";
import { CloneBusyError } from "@/lib/engine/cloneLease";

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
    if (typeof body.episodeId !== "string" || !body.episodeId.trim()) {
      return NextResponse.json({ error: "Pick a scenario for the day." }, { status: 400 });
    }
    for (const key of ["judge", "director", "seedWorld"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean.` }, { status: 400 });
      }
    }
    if (body.compression !== undefined && (typeof body.compression !== "number" ||
        !Number.isFinite(body.compression) || body.compression < 1 || body.compression > 3600)) {
      return NextResponse.json({ error: "compression must be between 1 and 3600." }, { status: 400 });
    }
    if (body.ticks !== undefined && (!Number.isInteger(body.ticks) || body.ticks < 1)) {
      return NextResponse.json({ error: "ticks must be a positive integer." }, { status: 400 });
    }
    if (body.agentLabel !== undefined && typeof body.agentLabel !== "string") {
      return NextResponse.json({ error: "agentLabel must be a string." }, { status: 400 });
    }
    if (body.twins !== undefined && (!Array.isArray(body.twins) ||
        body.twins.some(t => !TWIN_NAMES.includes(t)))) {
      return NextResponse.json({ error: "twins must contain supported app names." }, { status: 400 });
    }

    const view = startSession({
      episodeId: body.episodeId,
      timing: normalizeSessionTiming(body.timing),
      compression: body.compression ?? 60,
      ...(body.agentLabel ? { agentLabel: body.agentLabel } : {}),
      ...(body.twins ? { twins: body.twins } : {}),
      ...(body.ticks === undefined ? {} : { ticks: body.ticks }),
      ...(body.seedWorld === undefined ? {} : { seedWorld: body.seedWorld }),
      ...(body.judge === undefined ? {} : { judge: body.judge }),
      ...(body.director === undefined ? {} : { director: body.director }),
    });
    return NextResponse.json(await sessionLaunch(view), { status: 201 });
  } catch (err) {
    // Bad request, not a server fault: what fails here is a scenario that does
    // not resolve, and the message names the ones that do.
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof CloneBusyError ? 409 : 400 });
  }
}
