import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listActions, listSessions } from "@/lib/audit";
import { checkSandboxToken } from "@/lib/calendar/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The harness's audit trail is separate from the provider calendar API.
export function GET(req: Request) {
  const denied = checkSandboxToken(req);
  if (denied) return denied;
  const db = getDb();
  const sp = new URL(req.url).searchParams;
  const num = (key: string): number | undefined => {
    const raw = sp.get(key);
    const n = Number(raw);
    return raw && Number.isFinite(n) ? n : undefined;
  };
  return NextResponse.json({
    sessions: listSessions(db),
    actions: listActions(db, {
      sessionId: sp.get("sessionId") || undefined,
      sinceId: num("sinceId"),
      beforeId: num("beforeId"),
      limit: num("limit"),
    }),
  });
}
