import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { parseSeedRequest, seed } from "@/lib/sandbox/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sandbox/seed — load a cloned company: { twin: "slack", seed }.
// Answers `{ ok: true, counts }`, or a 400 saying what to fix. Seeding is total
// and idempotent: the workspace is rebuilt from the body, never added to. With
// `promoteToSnapshot` the seeded world also becomes the state every later reset
// in the run returns to.
//
// In-process like /api/sandbox/reset: the server owns the working SQLite handle,
// so only it can safely close → swap files → reopen.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const parsed = parseSeedRequest(await req.json().catch(() => null));
    return NextResponse.json(seed(parsed));
  } catch (err) {
    return sandboxError(err, err instanceof BadRequestError ? 400 : 500);
  }
}
