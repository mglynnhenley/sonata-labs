import { NextResponse } from "next/server";
import { finalizeSession } from "@/lib/engine/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Trusted harness control. It is not exposed as an agent business tool. */
export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = await req.json().catch(() => null) as { status?: unknown; reason?: unknown } | null;
    if (!body || !["aborted", "failed"].includes(String(body.status)) ||
        (body.reason !== undefined && typeof body.reason !== "string")) {
      return NextResponse.json({ error: "Provide status 'aborted' or 'failed' and an optional reason." }, { status: 400 });
    }
    const session = await finalizeSession(sessionId, {
      status: body.status as "aborted" | "failed",
      ...(body.reason === undefined ? {} : { reason: body.reason as string }),
    });
    if (!session) return NextResponse.json({ error: "No session with that id." }, { status: 404 });
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
