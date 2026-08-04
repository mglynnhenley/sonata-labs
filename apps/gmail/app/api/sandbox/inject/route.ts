import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { injectEmail, parseInjectRequest } from "@/lib/sandbox/inject";
import { liveDb } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/inject — play one beat into the mailbox at a simulated time:
//   { kind: "email", from, to, cc, subject, body, threadRef?, labels?, atMs }
// Returns the message and thread ids so the engine can thread the next beat onto
// this one. Deliberately NOT audit-logged: the audit log is the agent's record
// and grading reads it, so the world's own moves must stay out of it.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const parsed = parseInjectRequest(await req.json().catch(() => null));
    const injected = injectEmail(liveDb(), parsed);
    return NextResponse.json({ ok: true, injected });
  } catch (err) {
    return sandboxError(err, err instanceof BadRequestError ? 400 : 500);
  }
}
