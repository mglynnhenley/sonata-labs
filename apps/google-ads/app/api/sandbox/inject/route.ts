import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { injectBeat, type InjectBody } from "@/lib/sandbox/inject";
import { liveDb } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One world beat at simulated time: yesterday's spend lands, a budget moves, a
// campaign flips status. The whole beat runs in one transaction and is
// deliberately NOT audit-logged — the audit log is the AGENT's record and the
// judge reads it to score the agent, so the world's own hand must leave no
// trace in it.
//
// Reads through liveDb(), not getDb(), because a seed run from another process
// swaps working.db underneath this one.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as InjectBody;
    return NextResponse.json({ ok: true, injected: injectBeat(liveDb(), body) });
  } catch (err) {
    return sandboxError(err, err instanceof BadRequestError ? 400 : 500);
  }
}
