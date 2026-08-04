import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { injectEvent, parseInjectRequest } from "@/lib/sandbox/inject";
import { liveDb } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/inject — play one beat into the workspace at a simulated time:
//   { kind: "message" | "thread_reply" | "reaction", channel, user, text, threadTs?, atMs }
// Returns the ts and channel id so the engine can hang the next beat off this
// one. Deliberately NOT audit-logged: the audit log is the agent's record and
// grading reads it, so the world's own moves must stay out of it. Events API
// subscribers still see it — a coworker's message is a real message.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const parsed = parseInjectRequest(await req.json().catch(() => null));
    const injected = injectEvent(liveDb(), parsed);
    return NextResponse.json({ ok: true, injected });
  } catch (err) {
    return sandboxError(err, err instanceof BadRequestError ? 400 : 500);
  }
}
