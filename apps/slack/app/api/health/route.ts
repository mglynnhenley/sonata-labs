import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countMessages } from "@/lib/store/messages";
import { countUsers } from "@/lib/store/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    return NextResponse.json({
      ok: true,
      messages: countMessages(db),
      users: countUsers(db),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
