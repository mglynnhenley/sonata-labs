import { NextResponse } from "next/server";
import { snapshotWorking } from "@/lib/reset";
import { checkSandboxToken } from "@/lib/calendar/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Promote the current world to the pristine baseline. This is how a generated
// business becomes the thing every later run resets back to — seed or inject
// first, then snapshot, then every reset returns to exactly this state.
export async function POST(req: Request) {
  const denied = checkSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ status: "ok", ...snapshotWorking() });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
