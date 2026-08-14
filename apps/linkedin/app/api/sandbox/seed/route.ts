import { NextResponse } from "next/server";
import { requireSandboxToken } from "@/lib/sandbox/auth";
import { BadRequestError, parseSeedRequest } from "@/lib/sandbox/parse";
import { seedFromWire } from "@/lib/sandbox/seed";
import { markWorkingSwapped } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/seed — load a cloned business: { twin: "linkedin", seed }.
// The contract is written out in full at the top of packages/world/src/inject.ts.
//
// In-process like /api/sandbox/reset: the server owns the working SQLite handle,
// so only it can safely wipe it and (when promoting) swap the snapshot file.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const seed = parseSeedRequest(await req.json().catch(() => null));
    const result = seedFromWire(seed);
    // Promotion closed and reopened the handle underneath us; record the new
    // inode so liveDb() does not throw the fresh connection away on next read.
    if (seed.promoteToSnapshot) markWorkingSwapped();
    return NextResponse.json(result);
  } catch (err) {
    // A rejected seed is the caller's to fix, so it answers 400 with the reason;
    // only a genuinely broken twin is a 500.
    const status = err instanceof BadRequestError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}
