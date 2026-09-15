import { redirect } from "next/navigation";
import { canCallModels, getSettings } from "@/lib/settings";
import { getEpisode, listEpisodes } from "../api/_lib/records";
import { activeRun, listRuns, resumeInterruptedRuns } from "../api/_lib/runner";
import { getScenario } from "@sonata/scenarios";
import { RunsClient } from "./_components/RunsClient";
import { unregisteredShipped } from "../scenarios/_lib/shippedSummary";

// Runs move every second, so nothing here is cached. The server paints the
// current state; the client polls on from it.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Runs",
  description: "Start a simulated workday, watch it play out, and browse the ones that already ran.",
};

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string; demo?: string }>;
}) {
  const { scenario, demo } = await searchParams;
  // Old demo bookmarks now enter the same review flow as every other scenario.
  if (demo === "1") redirect("/scenarios");
  resumeInterruptedRuns();

  const active = activeRun();
  // Shipped scenarios belong in the picker before their first run, not after it.
  // Selecting one and pressing Start is what registers it, which is the same
  // path `resolveScenario` has always taken — it just no longer requires knowing
  // the id to get there.
  const registered = listEpisodes();
  const episodes = [...registered, ...unregisteredShipped(registered.map((episode) => episode.id))];

  // Which ticks each scenario has scripted moments on. Read here, off the saved
  // spec, because `EpisodeSummary` carries only a beat COUNT — and a run panel
  // offering a short day has to be able to say how many of those beats the short
  // day cuts off, not merely that some might be.
  const beatTicks: Record<string, number[]> = {};
  for (const episode of episodes) {
    const spec = getEpisode(episode.id)?.spec ?? getScenario(episode.id);
    beatTicks[episode.id] = (spec?.beats ?? []).map((beat) => beat.tick);
  }

  return (
    <RunsClient
      initial={{ runs: listRuns(), activeRunId: active?.runId ?? null, at: Date.now() }}
      episodes={episodes}
      defaultModel={getSettings().models.agent}
      beatTicks={beatTicks}
      hasKey={canCallModels()}
      {...(scenario && episodes.some((e) => e.id === scenario)
        ? { initialEpisodeId: scenario }
        : {})}
    />
  );
}
