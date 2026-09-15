import { scenarioIds } from "@sonata/scenarios";
import { getEpisode, getWorld, listEpisodes } from "../api/_lib/records";
import { getTemplate, templateSummaries } from "../api/_lib/templates";
import { ScenariosClient } from "./_components/ScenariosClient";

// Saved scenarios carry the status of their last run, which moves while a day is
// playing — so this page is read fresh every time rather than cached.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scenarios",
  description: "Choose a business scenario and review its expected behavior before running an evaluation.",
};

export default async function ScenariosPage({
  searchParams,
}: {
  searchParams: Promise<{ environment?: string }>;
}) {
  const { environment } = await searchParams;
  const environmentFilter = environment
    ? { id: environment, name: getWorld(environment)?.name ?? "Selected environment" }
    : undefined;
  const episodes = listEpisodes();
  const expectations = Object.fromEntries(episodes.map((episode) => [
    episode.id,
    getEpisode(episode.id)?.spec.success.checklist.slice(0, 2).map((item) => item.description) ?? [],
  ]));
  const templates = templateSummaries().map((template) => {
    const authored = getTemplate(template.id)!;
    return {
      ...template,
      environmentName: authored.scenario.business.name,
      expectations: authored.scenario.episode.criteria.slice(0, 2).map((item) => item.description),
    };
  });
  return (
    <ScenariosClient
      initialEpisodes={episodes}
      expectations={expectations}
      environmentFilter={environmentFilter}
      templates={templates}
      shippedIds={scenarioIds()}
      initialNow={Date.now()}
    />
  );
}
