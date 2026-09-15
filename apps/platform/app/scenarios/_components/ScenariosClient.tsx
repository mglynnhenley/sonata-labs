"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  buttonClasses,
  Card,
  EmptyState,
  IconLayers,
  IconSpark,
  PageHeader,
  useToast,
} from "@sonata/ui";
import { useGo } from "../../_components/useGo";
import { apiSend } from "../../api/_lib/client";
import type { EpisodeSummary, TemplateSummary, WorldSummary } from "../../api/_lib/types";
import { episodeFromTemplate } from "../_lib/shipped";
import { SavedScenarioCard } from "./SavedScenarioCard";
import { TemplateCard, type TemplateAction, type ScenarioTemplate } from "./TemplateCard";

// Scenarios: what you have saved, and what ships in the box. Templates are the
// answer to an empty page — the spec's rule is that no page is ever blank, and
// the fastest route to a first run is "save one of these as a starting point".

export type ScenariosClientProps = {
  initialEpisodes: EpisodeSummary[];
  templates: ScenarioTemplate[];
  expectations: Record<string, string[]>;
  environmentFilter?: { id: string; name: string };
  /** The server's clock at paint. Every "3 d ago" on a card is measured against
   *  it, so the server HTML and the hydrated render agree. */
  initialNow: number;
  /** Ids of the benchmark days that ship with Sonata, so their cards say so. */
  shippedIds: string[];
};

export function ScenariosClient({ initialEpisodes, expectations, environmentFilter, templates, initialNow, shippedIds }: ScenariosClientProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();

  const [episodes, setEpisodes] = useState(initialEpisodes);
  const now = initialNow;
  const visibleEpisodes = environmentFilter
    ? episodes.filter((episode) => episode.worldId === environmentFilter.id)
    : episodes;
  const [busy, setBusy] = useState<{ id: string; action: TemplateAction } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function onTemplateAction(template: TemplateSummary, action: TemplateAction) {
    setBusy({ id: template.id, action });
    try {
      if (action === "environment") {
        const { world } = await apiSend<{ world: WorldSummary }>("/api/worlds", "POST", {
          templateId: template.id,
        });
        toast({
          title: `${world.name} is saved`,
          description: `${world.counts.people} people and ${world.counts.channels} channels saved. Open Environments to review and load the company into its apps.`,
          tone: "success",
          action: { label: "View environments", onClick: () => router.push("/companies") },
        });
        return;
      }

      const episode = await episodeFromTemplate(template.id);

      router.push(`/scenarios/${encodeURIComponent(episode.id)}`);
    } catch (err) {
      toast({ title: "That didn't work", description: (err as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(episode: EpisodeSummary) {
    setDeleting(episode.id);
    try {
      await apiSend<{ deleted: boolean }>(`/api/episodes/${episode.id}`, "DELETE");
      setEpisodes((current) => current.filter((e) => e.id !== episode.id));
      toast({
        title: `Deleted "${episode.title}"`,
        description: "Its runs are kept — a result has to outlive the scenario it came from.",
      });
    } catch (err) {
      toast({ title: "Could not delete it", description: (err as Error).message, tone: "error" });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="sn-stack-section">
      <PageHeader
        eyebrow="Workspace"
        title="Scenarios"
        subtitle="Choose what the agent will face, then review what good behavior looks like."
        actions={
          // A real anchor, so the page's main exit can be opened in a new tab.
          <a
            href="/scenarios/new"
            onClick={(e) => go(e, "/scenarios/new")}
            className={buttonClasses("primary", "lg")}
          >
            <IconSpark size="sm" />
            New scenario
          </a>
        }
      />

      <div className="grid gap-4 text-sn-base text-sn-muted sm:grid-cols-3">
        <p><strong className="font-medium text-sn-ink">Environment</strong><br />The company, its people, history and apps.</p>
        <p><strong className="font-medium text-sn-ink">Scenario</strong><br />The situation the agent must handle.</p>
        <p><strong className="font-medium text-sn-ink">Rubric</strong><br />The expected outcomes used to assess its work.</p>
      </div>

      <Card
        padding="lg"
        title="Saved scenarios"
        subtitle={environmentFilter
          ? `Scenarios in ${environmentFilter.name}`
          : "Review the environment, events and rubric before choosing an agent."}
        actions={
          environmentFilter ? (
            <a href="/scenarios" onClick={(e) => go(e, "/scenarios")} className={buttonClasses("ghost", "sm")}>
              Show all scenarios
            </a>
          ) : episodes.length > 0 ? (
            <span className="text-sn-sm text-sn-subtle">{episodes.length} saved</span>
          ) : undefined
        }
      >
        <div className="pt-1">
          {visibleEpisodes.length === 0 ? (
            <EmptyState
              icon={<IconLayers size="lg" />}
              title={environmentFilter ? "No scenarios in this environment yet" : "Nothing saved yet"}
              description={environmentFilter
                ? "This environment has no saved scenarios. You can browse all scenarios, or create a new scenario with its own environment."
                : "Describe a business and a situation, or save a starting point below. Review the generated rubric before your first run."}
              action={
                <a
                  href="/scenarios/new"
                  onClick={(e) => go(e, "/scenarios/new")}
                  className={buttonClasses("primary", "md")}
                >
                  <IconSpark size="sm" />
                  Create a scenario
                </a>
              }
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {visibleEpisodes.map((episode) => (
                <SavedScenarioCard
                  key={episode.id}
                  episode={episode}
                  expectations={expectations[episode.id] ?? []}
                  shipped={shippedIds.includes(episode.id)}
                  now={now}
                  deleting={deleting === episode.id}
                  onDelete={(target) => void onDelete(target)}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card
        padding="lg"
        title="Start from an example"
        subtitle="Save a scenario and its environment, then review the rubric. Saving an example does not start a run."
      >
        <div className="grid gap-4 pt-1 lg:grid-cols-2">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              busy={busy?.id === template.id ? busy.action : null}
              onAction={(target, action) => void onTemplateAction(target, action)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
