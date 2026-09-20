import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";
import { markWorkingSwapped } from "@/lib/sandbox/live";
import { requireSandboxToken } from "@/lib/sandbox/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-process reset: the server holds the working SQLite handle, so only it can
// safely close → swap files → reopen. The CLI `reset` posts here first and only
// falls back to a file copy when this server is down.
//
// Token-gated, unlike the Gmail twin's — this clone ships no UI that drives it,
// so there is no browser without a token that needs in.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    const result = resetWorking(body.note || "reset via API");
    // This process did the swap itself, so liveDb() must not reopen behind it.
    markWorkingSwapped();
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
