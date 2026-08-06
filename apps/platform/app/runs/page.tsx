import { getSettings } from "@/lib/settings";
import { getEpisode, listEpisodes } from "../api/_lib/records";
import { activeRun, listRuns, resumeInterruptedRuns } from "../api/_lib/runner";
import { RunsClient } from "./_components/RunsClient";

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
  resumeInterruptedRuns();

  const active = activeRun();
  const episodes = listEpisodes();

  // Which ticks each scenario has scripted moments on. Read here, off the saved
  // spec, because `EpisodeSummary` carries only a beat COUNT — and a run panel
  // offering a short day has to be able to say how many of those beats the short
  // day cuts off, not merely that some might be.
  const beatTicks: Record<string, number[]> = {};
  for (const episode of episodes) {
    beatTicks[episode.id] = (getEpisode(episode.id)?.spec.beats ?? []).map((beat) => beat.tick);
  }

  return (
    <RunsClient
      initial={{ runs: listRuns(), activeRunId: active?.runId ?? null, at: Date.now() }}
      episodes={episodes}
      defaultModel={getSettings().models.agent}
      beatTicks={beatTicks}
      {...(scenario && episodes.some((e) => e.id === scenario)
        ? { initialEpisodeId: scenario }
        : {})}
      demo={demo === "1"}
    />
  );
}
