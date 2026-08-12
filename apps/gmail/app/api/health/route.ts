import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authMode } from "@/lib/gmail/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .get() as { n: number };
    return NextResponse.json({
      status: "ok",
      messages: row.n,
      // How /gmail/v1/* is gated right now — the UI and the live gates read the
      // mode from here rather than carrying their own copy of SANDBOX_AUTH.
      auth: authMode(),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", error: (err as Error).message },
      { status: 500 },
    );
  }
}
