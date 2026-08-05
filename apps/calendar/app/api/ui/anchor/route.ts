import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getDefaultTimeZone } from "@/lib/store/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where the week view should open. The sim runs on backdated/future dates, so
// anchoring on wall-clock "now" would open most demos on an empty grid — the
// grid instead defaults to the week containing the most recent event start.
export function GET() {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(start_ms) AS anchor FROM events WHERE status != 'cancelled'")
    .get() as { anchor: number | null };
  return NextResponse.json({
    anchorMs: row.anchor,
    timeZone: getDefaultTimeZone(db),
  });
}
