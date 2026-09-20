import { SCENARIOS } from "@sonata/scenarios";
import { getEpisode, getWorld, listEpisodes } from "../api/_lib/records";
import { getTemplate, templateSummaries } from "../api/_lib/templates";
import { ScenariosClient } from "./_components/ScenariosClient";
import { unregisteredShipped } from "./_lib/shippedSummary";

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
  // Registered scenarios, plus every shipped one nobody has run yet.
  //
  // A shipped day only becomes a record the first time something resolves it,
  // which used to mean the page showed whichever ones this machine happened to
  // have run before. Seven of the thirteen were invisible on a fresh install,
  // including both continuity weeks, and the only way to reach one was to know
  // its id. Registration still happens on first run; this just stops the
  // catalogue being a history of what you already did.
  const registered = listEpisodes();
  const known = new Set(registered.map((episode) => episode.id));
  const unregistered = unregisteredShipped(known);
  const episodes = [...registered, ...unregistered];
  const expectations = Object.fromEntries(episodes.map((episode) => [
    episode.id,
    (getEpisode(episode.id)?.spec ?? SCENARIOS.find((spec) => spec.id === episode.id))
      ?.success.checklist.slice(0, 2).map((item) => item.description) ?? [],
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
      shippedIds={SCENARIOS.map((spec) => spec.id)}
      savedIds={registered.map((episode) => episode.id)}
      initialNow={Date.now()}
    />
  );
}
