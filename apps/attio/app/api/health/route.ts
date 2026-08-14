import { NextResponse } from "next/server";
import { liveDb } from "@/lib/sandbox/live";
import { countRecords } from "@/lib/store/records";
import { countNotes } from "@/lib/store/notes";
import { countTasks } from "@/lib/store/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness and counts. Ungated, and it must ANSWER when the database is missing
// rather than throw: a twin that fails to respond looks unreachable, while one
// that reports `{status: "error", error}` tells the dashboard and `sonata
// doctor` exactly what to fix. Both markers are returned because the consumers
// disagree — the engine tests `status === "ok"` literally while the dashboard
// and the CLI accept either — and every count is a number because the engine
// renders each numeric field as "<n> <key>".
//
// liveDb() rather than getDb(): `npm run seed` swaps working.db from another
// process, and a handle opened before the swap keeps serving the file it was
// opened on. Health reporting the counts of a database nobody is using any more
// is the most misleading answer this route could give.
export function GET() {
  try {
    const db = liveDb();
    return NextResponse.json({
      status: "ok",
      ok: true,
      records: countRecords(db),
      notes: countNotes(db),
      tasks: countTasks(db),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
