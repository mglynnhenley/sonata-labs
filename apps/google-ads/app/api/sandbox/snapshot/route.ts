import { NextResponse } from "next/server";
import { snapshotWorking } from "@/lib/reset";
import { requireSandboxToken } from "@/lib/sandbox/auth";
import { liveDb, markWorkingSwapped } from "@/lib/sandbox/live";
import { buildSnapshot } from "@/lib/sandbox/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The two verbs mean different things, and the existing clones disagree about
// which is which — so this file says it out loud:
//
//   GET  — the account as the JUDGE sees it: a capped digest, read through
//          liveDb() so an out-of-process seed cannot leave it reading a
//          now-nameless inode. This is gmail's and slack's meaning.
//   POST — promote working.db to the pristine baseline every later reset returns
//          to. This is calendar's meaning, and it is how a generated account
//          becomes the state a run starts from.

export function GET(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json(buildSnapshot(liveDb()));
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}

export function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const result = snapshotWorking();
    markWorkingSwapped();
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
