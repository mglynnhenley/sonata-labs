import { NextResponse } from "next/server";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { liveDb } from "@/lib/sandbox/live";
import { captureTwinSnapshot } from "@/lib/sandbox/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sandbox/snapshot — the workspace as the judge sees it: channels with
// member/message counts, topic and the owner's read cursor, plus recent message
// digests (ts, author, truncated text + hash, reactions, reply count). Two of
// these ship inside every run artifact, so it is capped and digested, never a
// full history dump.
//
// Read through `liveDb`, not `getDb`: a snapshot that answered from a working.db
// somebody swapped underneath us would score the agent against a world nobody
// else can see.
export async function GET(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json(captureTwinSnapshot(liveDb()));
  } catch (err) {
    return sandboxError(err);
  }
}
