import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";
import { markWorkingSwapped } from "@/lib/sandbox/live";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-process reset: the server holds the working SQLite handle, so only it can
// safely close → swap files → reopen. The CLI `reset` posts to this endpoint and
// only falls back to a direct file copy when the server is down.
//
// Gated, unlike the Slack clone's — nothing in this clone's UI drives a reset,
// so there is no browser without a token that needs it.
export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    const counts = resetWorking(body.note || "reset via API");
    markWorkingSwapped();
    return NextResponse.json({ status: "ok", ...counts });
  } catch (err) {
    return sandboxError(err);
  }
}
