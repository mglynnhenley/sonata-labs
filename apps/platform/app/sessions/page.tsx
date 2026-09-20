import { listSessions, sessionScenarios, sweepOrphanSessions } from "@/lib/engine/session";
import { SessionsClient } from "./_components/SessionsClient";

// A session moves on its own clock, so nothing here is cached: the server paints
// the current state and the client polls on from it.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sessions",
  description:
    "Try a private simulated workday in the browser, with scripted events at the speed you choose.",
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; scenario?: string }>;
}) {
  // A session is a timer in memory, and a restart takes it with no chance to
  // write anything down. Sweep before the first paint so a row can never claim
  // to be running with a clock that stopped moving hours ago.
  sweepOrphanSessions();
  const { scenario } = await searchParams;

  return (
    <SessionsClient
      initial={{ sessions: listSessions(), at: Date.now() }}
      scenarios={sessionScenarios()}
      initialEpisodeId={scenario}
    />
  );
}
