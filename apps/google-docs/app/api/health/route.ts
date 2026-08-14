import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countDocuments, countParagraphs } from "@/lib/store/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness plus counts: the engine's preflight, the dashboard card and
// `sonata doctor` all read this, and it is the one route with no credential.
//
// `status` must be the literal string "ok" —
// packages/engine/src/adapters/shared.ts:61 tests it that way, and the Slack
// twin returns `{ok:true}` instead, which is why it reports unhealthy through the
// preflight while looking fine to curl. A missing database is returned, not
// thrown: a probe that cannot answer is indistinguishable from a dead port.
export function GET() {
  try {
    const db = getDb();
    return NextResponse.json({
      status: "ok",
      documents: countDocuments(db),
      paragraphs: countParagraphs(db),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
