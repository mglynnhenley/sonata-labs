import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";
import { checkSandboxToken } from "@/lib/calendar/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-process reset: the server holds the working SQLite handle, so only it can
// safely close → swap files → reopen. The CLI `reset` posts to this endpoint.
export async function POST(req: Request) {
  const denied = checkSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    const result = resetWorking(body.note || "reset via API");
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
