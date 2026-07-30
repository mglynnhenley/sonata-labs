import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listSessions, listActions } from "@/lib/audit";
import { listOutbox } from "@/lib/store/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// Feeds the activity panel (P6). Poll with ?sessionId=&sinceId= for live tail.
// Grading reads the same feed but must see EVERY action, so `beforeId` pages
// backwards past the limit — without it an agent that takes more actions than
// the page size gets silently truncated and graded on a partial log.
export function GET(req: Request) {
  try {
    const db = getDb();
    const sp = new URL(req.url).searchParams;
    const sessions = listSessions(db);
    const sessionId = sp.get("sessionId") || sessions[0]?.id;
    const sinceId = sp.get("sinceId") ? Number(sp.get("sinceId")) : undefined;
    const beforeId = sp.get("beforeId") ? Number(sp.get("beforeId")) : undefined;
    const rawLimit = sp.get("limit") ? Number(sp.get("limit")) : DEFAULT_LIMIT;
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const actions = sessionId
      ? listActions(db, { sessionId, sinceId, beforeId, limit })
      : [];
    return NextResponse.json({
      sessions,
      currentSessionId: sessionId ?? null,
      actions,
      hasMore: actions.length === limit,
      outbox: listOutbox(db),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
