import { NextResponse } from "next/server";
import { snapshotWorking } from "@/lib/reset";
import { requireSandboxToken } from "@/lib/sandbox/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This path has two established meanings across the clones; this one is the
// PROMOTE meaning. It makes the current working DB the pristine baseline: seed
// or inject first, then snapshot, and every later reset returns to exactly this
// state — which is how a generated business survives an episode.
//
// The judge's-view GET is deliberately not implemented here. The engine's
// adapters capture a twin through its provider API, so a second capture path
// would be a second thing to keep true.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ status: "ok", ...snapshotWorking() });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
