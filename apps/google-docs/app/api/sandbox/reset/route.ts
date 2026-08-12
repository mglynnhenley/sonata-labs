import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";
import { requireSandboxToken } from "@/lib/sandbox/auth";
import { markWorkingSwapped } from "@/lib/sandbox/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-process reset: the server holds the working SQLite handle, so only it can
// safely close → swap files → reopen. The CLI `reset` posts to this endpoint and
// only copies files itself when nothing answers. Gated — this clone ships no UI
// that would need to call it without a credential.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    const result = resetWorking(body.note || "reset via API");
    // The swap was ours, so record the new inode rather than letting liveDb()
    // discover it and close a handle that is already correct.
    markWorkingSwapped();
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
