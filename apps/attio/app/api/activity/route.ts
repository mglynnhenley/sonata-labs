import { NextResponse } from "next/server";
import { liveDb } from "@/lib/sandbox/live";
import { listActions, listSessions } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The audit trail, for the run replay and the judge. Read-only, so no token
// gate — it is the evidence, not a lever. `beforeId` pages backwards, which is
// required so grading is never silently truncated at the newest 200 rows.
//
// liveDb() rather than getDb(), for the same reason health uses it: an
// out-of-process seed or reset swaps the file, and the audit trail read off a
// stale handle is evidence about a world that no longer exists.
export function GET(req: Request) {
  const db = liveDb();
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
