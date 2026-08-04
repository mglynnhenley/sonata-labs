import { listEpisodes } from "../api/_lib/records";
import { templateSummaries } from "../api/_lib/templates";
import { ScenariosClient } from "./_components/ScenariosClient";

// Saved scenarios carry the status of their last run, which moves while a day is
// playing — so this page is read fresh every time rather than cached.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scenarios",
  description: "Saved scenarios and the ready-made days that ship with Sonata.",
};

export default async function ScenariosPage() {
  return <ScenariosClient initialEpisodes={listEpisodes()} templates={templateSummaries()} />;
}
