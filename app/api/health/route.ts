import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", error: (err as Error).message },
      { status: 500 },
    );
  }
}
