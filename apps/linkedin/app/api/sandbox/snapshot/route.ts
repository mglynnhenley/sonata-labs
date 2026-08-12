import { NextResponse } from "next/server";
import { snapshotWorking } from "@/lib/reset";
import { markWorkingSwapped } from "@/lib/sandbox/live";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This route has TWO established meanings in this repo, so it says which one it
// implements: this is the CALENDAR meaning — promote the current working world
// to the pristine baseline, so a generated business becomes the thing every
// later reset returns to. Seed or inject first, then snapshot, then every reset
// comes back to exactly this.
//
// It is NOT the Gmail/Slack meaning (a GET returning the world as the judge sees
// it). A phase-2 engine adapter captures the world through the provider API,
// which is what every existing adapter already does.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const counts = snapshotWorking();
    markWorkingSwapped();
    return NextResponse.json({ status: "ok", ...counts });
  } catch (err) {
    return sandboxError(err);
  }
}
