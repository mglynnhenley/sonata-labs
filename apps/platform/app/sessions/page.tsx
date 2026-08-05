import { listSessions, sessionScenarios, sweepOrphanSessions } from "@/lib/engine/session";
import { allTwinStatuses } from "@/lib/twins";
import { SessionsClient } from "./_components/SessionsClient";

// A session moves on its own clock, so nothing here is cached: the server paints
// the current state and the client polls on from it.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sessions",
  description:
    "Plug your own agent in and let a simulated workday run at it — on a wall clock, at whatever speed you choose.",
};

export default async function SessionsPage() {
  // A session is a timer in memory, and a restart takes it with no chance to
  // write anything down. Sweep before the first paint so a row can never claim
  // to be running with a clock that stopped moving hours ago.
  sweepOrphanSessions();

  const twins = (await allTwinStatuses()).map((status) => ({
    twin: status.twin,
    url: status.url,
    ok: status.ok,
    detail: status.detail,
  }));

  return (
    <SessionsClient
      initial={{ sessions: listSessions(), at: Date.now() }}
      scenarios={sessionScenarios()}
      twins={twins}
    />
  );
}
