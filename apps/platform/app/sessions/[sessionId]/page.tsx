import { notFound } from "next/navigation";
import { sessionStatus, sweepOrphanSessions } from "@/lib/engine/session";
import { twinUrls } from "../../api/_lib/twins";
import { LiveSession } from "../_components/LiveSession";

// Never cached: the whole point of this page is that it is current. The server
// paints the day so far — every tick of it, straight out of platform.db — and
// the client takes over polling from that watermark.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const poll = sessionStatus(sessionId);
  return {
    title: poll ? `${poll.session.title} · ${poll.session.agentLabel}` : "Session not found",
  };
}

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  // A dev-server restart kills the world's timers. Settle anything they left
  // behind before reading, so this page never opens on a day nothing is playing.
  sweepOrphanSessions();

  const poll = sessionStatus(sessionId);
  if (!poll) notFound();

  return <LiveSession initial={poll} twinLinks={twinUrls(poll.session.twins)} />;
}
