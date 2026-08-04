import { notFound } from "next/navigation";
import { getRun, resumeInterruptedRuns, toDetail } from "../../api/_lib/runner";
import { twinUrls } from "../../api/_lib/twins";
import { LiveEpisode } from "../_components/LiveEpisode";

// Never cached: the whole point of this page is that it is current. The server
// paints the day so far, then the client takes over polling from that watermark.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const doc = getRun(runId);
  return { title: doc ? `${doc.specTitle} · ${doc.model}` : "Run not found" };
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  // A dev-server reload kills the tick timers; re-arm before reading, so a run
  // that was mid-day when the process restarted is moving again by first paint.
  resumeInterruptedRuns();

  const doc = getRun(runId);
  if (!doc) notFound();

  return <LiveEpisode initial={toDetail(doc)} twinLinks={twinUrls(doc.twins)} />;
}
