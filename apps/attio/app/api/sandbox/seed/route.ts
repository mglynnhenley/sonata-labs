import { NextResponse } from "next/server";
import { requireSandboxToken } from "@/lib/sandbox/auth";
import { BadRequestError, parseSeedRequest } from "@/lib/sandbox/parse";
import { seedFromWire } from "@/lib/sandbox/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/seed — load a cloned business: { twin: "attio", seed }.
//
// In-process like /api/sandbox/reset: the server owns the working SQLite handle,
// so only it can safely wipe it and (when promoting) swap the snapshot file.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json(seedFromWire(parseSeedRequest(await req.json().catch(() => null))));
  } catch (err) {
    // A rejected seed is the caller's to fix, so it answers 400 with the reason;
    // only a genuinely broken twin is a 500.
    const status = err instanceof BadRequestError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
