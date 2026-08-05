import { readBrief, readRun } from "../../../../results/_lib/artifacts";
import { buildRunReport } from "../../../../results/_lib/report";

// The design-partner report, as a file. The run page renders the same document
// inline; this route is the download — a Markdown attachment named for the run,
// ready to hand over or drop into a PDF. Same source as the page (`buildRunReport`
// over the artifact), so the file and the screen can never disagree.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) {
    return new Response("No run with that id.", { status: 404, headers: { "content-type": "text/plain" } });
  }

  const markdown = buildRunReport(run, readBrief(runId));
  // The id is a safe filename base (it passed `readRun`'s guard) but the header
  // is user-facing, so keep it to the id rather than the free-text title.
  const filename = `sonata-report-${runId}.md`;
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
