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
import { apiGet, apiSend } from "../../api/_lib/client";
import type { EpisodeSummary, TemplateSummary, WorldSummary } from "../../api/_lib/types";
import { episodeFromTemplate } from "../_lib/shipped";
import { SavedScenarioCard } from "./SavedScenarioCard";
import { TemplateCard, type TemplateAction } from "./TemplateCard";

// Scenarios: what you have saved, and what ships in the box. Templates are the
// answer to an empty page — the spec's rule is that no page is ever blank, and
// the fastest route to a first run is "save one of these as a starting point".

export type ScenariosClientProps = {
  initialEpisodes: EpisodeSummary[];
  templates: TemplateSummary[];
  /** The server's clock at paint. Every "3 d ago" on a card is measured against
   *  it, so the server HTML and the hydrated render agree. */
  initialNow: number;
};

export function ScenariosClient({ initialEpisodes, templates, initialNow }: ScenariosClientProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();

  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [now, setNow] = useState(initialNow);
  const [busy, setBusy] = useState<{ id: string; action: TemplateAction } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function reload() {
    try {
      const { episodes: next, at } = await apiGet<{ episodes: EpisodeSummary[]; at: number }>(
        "/api/episodes",
      );
      setEpisodes(next);
      setNow(at);
    } catch {
      // The list is already on screen and still true; a failed refresh is not
      // worth a dialog. The next navigation re-reads it from the server anyway.
    }
  }

  async function onTemplateAction(template: TemplateSummary, action: TemplateAction) {
    setBusy({ id: template.id, action });
    try {
      if (action === "environment") {
        // This route saves the company; it does not touch the clones. Saying
        // "the same cast in all three clones" here — and offering to open an
        // inbox still holding whatever was seeded last — was two promises this
        // click does not keep. The cast and the channels are what exists now;
        // the inbox, the backlog and the calendar are written by seeding.
        const { world } = await apiSend<{ world: WorldSummary }>("/api/worlds", "POST", {
          templateId: template.id,
        });
        toast({
          title: `${world.name} is saved`,
          description: `${world.counts.people} people and ${world.counts.channels} channels. Seed it from Companies to write its inbox, Slack and calendar into the clones.`,
          tone: "success",
          action: { label: "Go to Companies", onClick: () => router.push("/companies") },
        });
        return;
      }

      const episode = await episodeFromTemplate(template.id);

      if (action === "use") {
        router.push(`/runs?scenario=${encodeURIComponent(episode.id)}`);
        return;
      }

      await reload();
      toast({
        title: "Saved a copy",
        description: `"${episode.title}" is yours now — edit it by describing what you want changed, or run it as it is.`,
        tone: "success",
      });
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
        title="Scenarios"
        subtitle="A scenario is one simulated workday inside a cloned business: who works there, what happens and when, and what counts as having done the job."
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

      <Card
        padding="lg"
        title="Saved scenarios"
        subtitle="Days you have written or kept, each with its own success criteria"
        actions={
          episodes.length > 0 ? (
            <span className="text-[12px] text-sn-subtle">
              {episodes.length} saved on this machine
            </span>
          ) : undefined
        }
      >
        <div className="pt-1">
          {episodes.length === 0 ? (
            <EmptyState
              icon={<IconLayers size="lg" />}
              title="Nothing saved yet"
              description="Create one from scratch, or save a template below as a starting point. Either way you get a whole fake company — an inbox, Slack channels and a calendar, with the same people in all three."
              hints={[
                "Describe the business in a sentence and watch it become a working day",
                "Every scenario carries its own success criteria, so a run always has a score",
                "Nothing leaves this machine and no real account is ever touched",
              ]}
              action={
                <a
                  href="/scenarios/new"
                  onClick={(e) => go(e, "/scenarios/new")}
                  className={buttonClasses("primary", "md")}
                >
                  <IconSpark size="sm" />
                  Describe a business
                </a>
              }
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {episodes.map((episode) => (
                <SavedScenarioCard
                  key={episode.id}
                  episode={episode}
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
        title="Templates"
        subtitle="The five days the benchmark runs. Each one is written so it cannot be solved by reading a single message — the fact the agent needs is always on a different surface from the place it is asked for, and the day keeps changing after the agent starts working."
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
