import { requireSandboxToken } from "@/lib/sandbox/auth";
import { NextResponse } from "next/server";
import { liveDb } from "@/lib/sandbox/live";
import { listActions, listSessions } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Harness evidence is private to the control credential. `beforeId` pages
// backwards so grading never silently truncates to the newest 200 actions.
export function GET(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
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
