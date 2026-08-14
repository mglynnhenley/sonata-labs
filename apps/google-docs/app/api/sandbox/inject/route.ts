import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { injectDocs } from "@/lib/sandbox/inject";
import { liveDb } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/inject — one world beat at simulated time: a colleague shares
// a brief, or revises the section the agent is working in.
//
// Deliberately NOT wrapped in runMutation. The audit log is the agent's record
// and the judge reads it, so the director's moves must stay out of it — getting
// this backwards scores the world's own moves as the agent's work. The whole beat
// still runs in ONE transaction, so a half-applied batch of edits is impossible.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    const db = liveDb();
    const injected = db.transaction(() => injectDocs(db, body))();
    return NextResponse.json({ ok: true, injected });
  } catch (err) {
    if (err instanceof BadRequestError) return sandboxError(err, 400);
    return sandboxError(err);
  }
}
