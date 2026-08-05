import { NextResponse } from "next/server";
import { escalate } from "@/lib/engine/session";

// The one thing a session cannot see for itself.
//
// Everything else the agent does lands in a twin's audit log and is read back
// from there. Handing the job back to a human touches nothing, so it leaves no
// row — and the autonomy score's independence component is exactly the count of
// those hand-backs. Until whatever fronts the agent reports one (an MCP server
// exposing `escalate_to_owner`, a harness wrapper, a person), a session reads
// the agent as fully independent, and the artifact's caveats say so.
//
//   POST /api/sessions/<id>/escalate  { "text": "I need a decision on the refund" }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await params;
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) {
      return NextResponse.json(
        { error: "Say what the agent handed back, in its own words." },
        { status: 400 },
      );
    }

    if (!escalate(sessionId, text)) {
      // Not 404: the session may exist and simply be over. Either way there is
      // no running day to attach this to, and silently dropping it would leave
      // an autonomy score that quietly overstates the agent.
      return NextResponse.json(
        { error: "That session is not running here, so there is no day to record this on." },
        { status: 409 },
      );
    }
    return NextResponse.json({ recorded: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
