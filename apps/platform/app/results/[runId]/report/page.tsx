import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@sonata/ui";
import { readBrief, readRun } from "../../_lib/artifacts";
import { buildRunReport } from "../../_lib/report";
import { ReportView } from "../../_components/ReportView";

// The design-partner report for one run. It reads the same artifact the run page
// does and assembles it into a document — what the agent did, where it failed,
// and the access the workflow actually needed — that reads as testing rather
// than a pitch, because every number in it is the run's own.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  return { title: run ? `Report · ${run.specTitle}` : "Report not found" };
}

export default async function ReportPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) notFound();

  const markdown = buildRunReport(run, readBrief(runId));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href={`/results/${encodeURIComponent(runId)}`} className="hover:text-sn-ink">
            {run.specTitle}
          </Link>
        }
        title="Design-partner report"
        subtitle="A third-party write-up of this run, ready to send. Copy it, or download the Markdown."
      />
      <ReportView runId={runId} markdown={markdown} />
    </div>
  );
}
