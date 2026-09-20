import { readFileSync } from "node:fs";
import path from "node:path";
import { runsDir } from "../../../../results/_lib/artifacts";
import { getRun } from "../../../_lib/runner";

export const runtime = "nodejs";
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[\w-]+$/.test(runId)) return Response.json({ error: "Invalid run id." }, { status: 400 });
  const run = getRun(runId);
  if (run && ["queued", "running", "judging"].includes(run.status)) return Response.json({ error: "The run is still saving its evidence." }, { status: 409 });
  try { return new Response(readFileSync(path.join(runsDir(), `${runId}.json`), "utf8"), { headers: { "content-type": "application/json" } }); }
  catch { return Response.json({ error: "No saved artifact for this run." }, { status: 404 }); }
}
