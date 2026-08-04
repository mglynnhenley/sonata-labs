import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listSessions, listActions, getCurrentSessionId } from "@/lib/audit";
import { listOutbox } from "@/lib/store/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Feeds the activity panel: sessions, the action log for one session (default:
// current), and the outbox. `since` enables cheap polling; `all=1` returns
// every session's actions.
export async function GET(req: Request) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const sessions = listSessions(db);
    const sinceId = Number(url.searchParams.get("since") ?? "0") || 0;
    const all = url.searchParams.get("all") === "1";
    const sessionId = url.searchParams.get("session") ?? getCurrentSessionId(db);

    const actions = all
      ? sessions.flatMap((s) => listActions(db, s.id, 0))
      : listActions(db, sessionId, sinceId);

    return NextResponse.json({
      sessions,
      session_id: sessionId,
      actions: actions.map((a) => ({
        ...a,
        request: a.request_json ? JSON.parse(a.request_json) : null,
      })),
      outbox: listOutbox(db).map((o) => ({
        ...o,
        request: o.request_json ? JSON.parse(o.request_json) : null,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
