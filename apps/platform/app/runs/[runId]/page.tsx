import { notFound } from "next/navigation";
import type { EpisodeSpec, RunStatus } from "@sonata/core";
import { getEpisode } from "../../api/_lib/records";
import { getRun, resumeInterruptedRuns, toDetail } from "../../api/_lib/runner";
import { twinUrls } from "../../api/_lib/twins";
import { readBrief, readRun, readTrace, type SavedRun } from "../../results/_lib/artifacts";
import { costBreakdown } from "../../results/_lib/cost";
import { RunDetail } from "../../results/[runId]/RunDetail";
import { HarnessFaults } from "../../results/_components/HarnessFaults";
import { harnessReport, hasFaults, specDescribes, withFindings } from "../../results/_components/harness";
import { LiveEpisode } from "../_components/LiveEpisode";

// The one run URL. Live and finished are states of this page, not two
// addresses: while the day is playing the in-memory doc drives the live view,
// and once it is over the artifact on disk drives the verdict. The branch that
// used to live at every link site (`runHref`) lives here instead, so a link to
// a run is correct by construction.
//
// Never cached: the whole point of this page is that it is current. The server
// paints the state so far, then the client takes over polling from there.
export const dynamic = "force-dynamic";

const LIVE: readonly RunStatus[] = ["queued", "running", "judging"];

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const doc = getRun(runId);
  if (doc) return { title: `${doc.specTitle} · ${doc.model}` };
  const run = readRun(runId);
  return { title: run ? `${run.specTitle} · ${run.model}` : "Run not found" };
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  // A dev-server reload kills the tick timers; re-arm before reading, so a run
  // that was mid-day when the process restarted is moving again by first paint.
  resumeInterruptedRuns();

  const doc = getRun(runId);
  if (doc && LIVE.includes(doc.status)) {
    return <LiveEpisode initial={toDetail(doc)} twinLinks={twinUrls(doc.twins)} />;
  }

  const run = readRun(runId);
  if (run) {
    // The trace stays on the server: it carries verbatim provider bodies and
    // runs to megabytes. Only the projection the cost section needs crosses
    // the wire.
    const cost = costBreakdown(readTrace(runId), run.verdict?.cost ?? null);
    const brief = readBrief(runId);
    // Our own defects come out of the run BEFORE the run page sees it, so the
    // sections below can be read as what they claim to be: the agent's record.
    const { report, judge } = harnessReport({
      run,
      spec: scheduledDay(run),
      capture: run.evidence,
      offsetMinutes: brief.offsetMinutes,
    });
    return (
      <div className="flex flex-col gap-6">
        {hasFaults(report) ? <HarnessFaults report={report} /> : null}
        <RunDetail run={withFindings(run, judge)} brief={brief} cost={cost} />
      </div>
    );
  }

  // Finished in memory but the artifact never landed — show the day we have
  // rather than a 404 over a run that visibly just played.
  if (doc) return <LiveEpisode initial={toDetail(doc)} twinLinks={twinUrls(doc.twins)} />;
  notFound();
}

/**
 * The day this run was SCHEDULED to play, from the scenario it names.
 *
 * The artifact records the ticks that happened and not the ones that did not, so
 * the only place "twelve of thirty-two" can come from is the scenario. It is read
 * back from the store rather than from the run file because that is the record
 * the engine itself resolved to start the day — and `specDescribes` throws it out
 * if it has been edited since, because an omission invented off a scenario that
 * has moved on is worse than saying nothing.
 */
function scheduledDay(run: SavedRun): EpisodeSpec | null {
  const spec = getEpisode(run.specId)?.spec ?? null;
  return spec && specDescribes(run, spec) ? spec : null;
}
