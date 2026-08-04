import { NextResponse } from "next/server";
import { resetWorking } from "@/lib/reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reset must happen in-process: the server owns the working SQLite handle.
export async function POST(req: Request) {
  try {
    let note = "reset to snapshot";
    try {
      const body = (await req.json()) as { note?: string };
      if (body?.note) note = body.note;
    } catch {
      // no body — use the default note
    }
    const { messages } = resetWorking(note);
    return NextResponse.json({ ok: true, messages });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
