import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listSessions, listActions } from "@/lib/audit";
import { listOutbox } from "@/lib/store/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Feeds the activity panel (P6). Poll with ?sessionId=&sinceId= for live tail.
export function GET(req: Request) {
  try {
    const db = getDb();
    const sp = new URL(req.url).searchParams;
    const sessions = listSessions(db);
    const sessionId = sp.get("sessionId") || sessions[0]?.id;
    const sinceId = sp.get("sinceId") ? Number(sp.get("sinceId")) : undefined;
    const actions = sessionId
      ? listActions(db, { sessionId, sinceId, limit: 500 })
      : [];
    return NextResponse.json({
      sessions,
      currentSessionId: sessionId ?? null,
      actions,
      outbox: listOutbox(db),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
