import { NextResponse } from "next/server";
import { countEpisodes, countRuns, countWorlds, listLiveRuns } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is the dashboard itself up, and can it read its own database?
 *
 * All three clones answer `/api/health`, and the dashboard is the fourth service
 * on this machine — a script that waits for the stack to come up should not have
 * to special-case the one process it cannot ask. So this answers in the same
 * shape the clones do, `status: "ok"` with a couple of counts, and touches the
 * database rather than returning a constant: a platform that cannot open
 * platform.db is not healthy, and saying "ok" from a route that reads nothing
 * would be a health check that can never fail.
 *
 * `ok: true` rides along beside `status` because the Slack clone words it that
 * way, and one caller reading either key can cover all four services.
 */
export function GET() {
  try {
    return NextResponse.json({
      status: "ok",
      ok: true,
      worlds: countWorlds(),
      episodes: countEpisodes(),
      runs: countRuns(),
      activeRuns: listLiveRuns().length,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
