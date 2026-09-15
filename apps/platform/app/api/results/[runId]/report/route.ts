import { loadRunDocument } from "../../../../results/_lib/document";

// The design-partner report, as a file. The run page renders the same document
// inline; this route is the download — a Markdown attachment named for the run,
// ready to hand over or drop into a PDF. Same saved document as the page, so the file and the screen can never disagree.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const document = loadRunDocument(runId);
  if (!document) {
    return new Response("No run with that id.", { status: 404, headers: { "content-type": "text/plain" } });
  }

  const { markdown } = document;
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
