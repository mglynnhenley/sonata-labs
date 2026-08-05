import { allTwinStatuses } from "@/lib/twins";
import { ConnectClient } from "./ConnectClient";
import { connectionView } from "./_lib/connection";

// Rendered on the server so the snippet is already on screen — and already
// correct for this checkout — before any JavaScript runs. The client takes over
// polling the clones from there.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect your agent · Sonata Labs",
  description: "Point any agent at the Gmail, Slack and calendar clones, and check the connection before you wire it up.",
};

export default async function ConnectPage() {
  const [twins, connection] = await Promise.all([
    allTwinStatuses(),
    Promise.resolve(connectionView()),
  ]);
  return <ConnectClient connection={connection} initialTwins={twins} />;
}
