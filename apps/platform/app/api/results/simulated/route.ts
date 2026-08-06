import { NextResponse } from "next/server";
import { listSimulatedRuns } from "../../../results/_lib/artifacts";
import { SIMULATED_HINT, SIMULATED_REASON } from "../../../results/_lib/simulated";

// Which saved runs the stand-in fabricated.
//
// Home needs this and cannot derive it: its cards are built from the relational
// rows in src/lib/db, which carry a score and a status and nothing about where
// the day came from. The rows are already correct — a fabricated run's score is
// null, so it is in no mean — but "no result" is what a crash says too, and Home
// would print the same grey badge over both. This endpoint is the difference.
//
// Ids only, deliberately. The page needs to know WHICH rows to name, not what is
// in them, and the artifacts run to megabytes.
//
// A static segment beside `[runId]`, which Next resolves first: no run may be
// called "simulated", and none is — ids are minted `run_…` and `sess_…`.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = listSimulatedRuns();
    return NextResponse.json({
      runIds: runs.map((run) => run.runId),
      count: runs.length,
      reason: SIMULATED_REASON,
      hint: SIMULATED_HINT,
    });
  } catch (err) {
    // Same shape as every other route here: a caller that gets a 500 renders the
    // message, not an empty body.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
