import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listActions, listSessions } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audit trail, for the run replay and the judge. Read-only, so no token gate
// — it is the evidence, not a lever. `beforeId` pages backwards, which grading
// needs so a long run is never silently truncated at the newest 200 rows.
export function GET(req: Request) {
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
