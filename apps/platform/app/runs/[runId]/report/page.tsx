import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@sonata/ui";
import { readRun } from "../../../results/_lib/artifacts";
import { loadRunDocument } from "../../../results/_lib/document";
import { ReportView } from "../../../results/_components/ReportView";

// The same saved document as the Markdown download, including evidence gaps.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  return { title: run ? `Report · ${run.specTitle}` : "Report not found" };
}

export default async function ReportPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const document = loadRunDocument(runId);
  if (!document) notFound();
  const { run, markdown } = document;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href={`/runs/${encodeURIComponent(runId)}`} className="hover:text-sn-ink">
            {run.specTitle}
          </Link>
        }
        title="Benchmark run report"
        subtitle="Recorded outcomes, evidence and measurement limits. Copy it, or download the same document as Markdown."
      />
      <ReportView runId={runId} markdown={markdown} />
    </div>
  );
}
