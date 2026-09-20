import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countAll } from "@/lib/store/counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness plus counts, ungated. Three consumers read this and they disagree
// about the shape: the engine's preflight tests `status === "ok"` LITERALLY,
// while the dashboard and the CLI accept `ok === true || status === "ok"`, so
// both markers are emitted. Every other numeric field is rendered as "<n> <key>"
// with `time` the one excluded key.
//
// It must answer even when the database is missing — a plain 500 with no JSON
// body breaks res.json() on the dashboard side, which reads as a twin that is
// down rather than one that has not been seeded.
export function GET() {
  try {
    return NextResponse.json({
      status: "ok",
      ok: true,
      ...countAll(getDb()),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
