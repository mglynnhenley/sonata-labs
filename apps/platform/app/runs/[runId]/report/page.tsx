import Link from "next/link";
import { notFound } from "next/navigation";
import type { EpisodeSpec } from "@sonata/core";
import { PageHeader } from "@sonata/ui";
import { getEpisode } from "../../../api/_lib/records";
import { readBrief, readRun, type SavedRun } from "../../../results/_lib/artifacts";
import { buildRunReport } from "../../../results/_lib/report";
import { ReportView } from "../../../results/_components/ReportView";
import {
  harnessMarkdown,
  harnessReport,
  hasFaults,
  specDescribes,
  withFindings,
} from "../../../results/_components/harness";

// The design-partner report for one run. It reads the same artifact the run page
// does and assembles it into a document — what the agent did, where it failed,
// and the access the workflow actually needed — that reads as testing rather
// than a pitch, because every number in it is the run's own.
//
// Our own defects are lifted out of it and stated at the top, in our voice,
// BEFORE the assessment. This is the copy that leaves the building, so it is
// where the confusion costs most: a reader handed a day we cut short and a
// mailbox we never recorded, in one list beside four real failures, comes away
// with an opinion of the model that the evidence does not support.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  return { title: run ? `Report · ${run.specTitle}` : "Report not found" };
}

/** The day this run was scheduled to play — see the run page's own copy of this. */
function scheduledDay(run: SavedRun): EpisodeSpec | null {
  const spec = getEpisode(run.specId)?.spec ?? null;
  return spec && specDescribes(run, spec) ? spec : null;
}

/**
 * Put our section under the title and above the assessment.
 *
 * `buildRunReport` opens with an H1 and the one-line bottom line, then heads
 * every section with an H2. Immediately before the first of those is the only
 * position that is both after the document has said what it is and before it has
 * said anything about the agent. A document with no H2 is a stub, and appending
 * is then the same position.
 */
function withHarnessSection(markdown: string, section: string): string {
  const at = markdown.indexOf("\n## ");
  if (at < 0) return `${markdown}\n${section}\n`;
  return `${markdown.slice(0, at + 1)}${section}\n\n${markdown.slice(at + 1)}`;
}

export default async function ReportPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = readRun(runId);
  if (!run) notFound();

  const brief = readBrief(runId);
  const { report, judge } = harnessReport({
    run,
    spec: scheduledDay(run),
    capture: run.evidence,
    offsetMinutes: brief.offsetMinutes,
  });
  const assessment = buildRunReport(withFindings(run, judge), brief);
  const markdown = hasFaults(report)
    ? withHarnessSection(assessment, harnessMarkdown(report))
    : assessment;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href={`/runs/${encodeURIComponent(runId)}`} className="hover:text-sn-ink">
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
