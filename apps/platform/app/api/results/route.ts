import { NextResponse } from "next/server";
import { listRuns } from "../../results/_lib/artifacts";
import { buildBenchmark, summarizeRun } from "../../results/_lib/summary";

// Every finished run, and the benchmark pivot over the same rows. The page reads
// the artifacts directly — this exists so the numbers in the article can be
// pulled with curl, and so a live dashboard can poll for runs that just landed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const spec = params.get("spec");
    const model = params.get("model");

    const runs = listRuns()
      .map(summarizeRun)
      .filter((run) => (!spec || run.specId === spec) && (!model || run.model === model));

    return NextResponse.json({ runs, benchmark: buildBenchmark(runs) });
  } catch (err) {
    // Reading the artifact directory is filesystem work, and an unhandled throw
    // out of a route handler is an empty 500 body — which every caller here
    // renders as a bare "Internal Server Error". One shape, always: `{ error }`.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
