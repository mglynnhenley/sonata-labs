import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";
import { requireSandboxToken } from "@/lib/sandbox/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-process reset: the server holds the working SQLite handle, so only it can
// safely close → swap files → reopen. The CLI `reset` posts to this endpoint.
// Token-gated — this clone ships no UI that would need to call it unauthenticated.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    return NextResponse.json({ status: "ok", ...resetWorking(body.note || "reset via API") });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
