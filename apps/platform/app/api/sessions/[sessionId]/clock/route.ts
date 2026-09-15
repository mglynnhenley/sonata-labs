import { NextResponse } from "next/server";
import { advanceSessionClock } from "@/lib/engine/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const body = await req.json().catch(() => null);
  if (!body || !["wait", "finish"].includes(body.action) ||
      (body.action === "wait" && (!Number.isSafeInteger(body.afterNotification) || body.afterNotification < 0 ||
      (body.untilTick !== undefined && (!Number.isSafeInteger(body.untilTick) || body.untilTick < 0))))) {
    return NextResponse.json({ error: "Use wait with an observed notification sequence and optional timer, or finish." }, { status: 400 });
  }
  try {
    const result = await advanceSessionClock(sessionId, token, body.action === "finish" ? { action: "finish" } : {
      action: "wait", afterNotification: body.afterNotification,
      ...(body.untilTick === undefined ? {} : { untilTick: body.untilTick }),
    });
    if (!result) return NextResponse.json({ error: "No action-timed session for this credential." }, { status: 401 });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Clock control failed." }, { status: 409 });
  }
}
