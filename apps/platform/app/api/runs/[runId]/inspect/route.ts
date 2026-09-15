import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runsDir } from "../../../../results/_lib/artifacts";

export const runtime = "nodejs";
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[\w-]+$/.test(runId)) return Response.json({ error: "Invalid run id." }, { status: 400 });
  try {
    const dir = path.join(runsDir(), "inspect", runId);
    const file = readdirSync(dir).find(name => name.endsWith(".eval"));
    if (!file) throw new Error("No transcript");
    return new Response(readFileSync(path.join(dir, file)), { headers: {
      "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${runId}.eval"`,
    } });
  } catch { return Response.json({ error: "No Inspect transcript has been saved for this run." }, { status: 404 }); }
}
