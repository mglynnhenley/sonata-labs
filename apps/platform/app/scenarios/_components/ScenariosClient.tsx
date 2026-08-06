"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  EmptyState,
  IconLayers,
  IconSpark,
  PageHeader,
  useToast,
} from "@sonata/ui";
import { useGo } from "../../_components/useGo";
import { apiGet, apiSend } from "../../api/_lib/client";
import type { EpisodeRecord, EpisodeSummary, TemplateSummary, WorldSummary } from "../../api/_lib/types";
import { SavedScenarioCard } from "./SavedScenarioCard";
import { TemplateCard, type TemplateAction } from "./TemplateCard";

// Scenarios: what you have saved, and what ships in the box. Templates are the
// answer to an empty page — the spec's rule is that no page is ever blank, and
// the fastest route to a first run is "save one of these as a starting point".

export type ScenariosClientProps = {
  initialEpisodes: EpisodeSummary[];
  templates: TemplateSummary[];
};

export function ScenariosClient({ initialEpisodes, templates }: ScenariosClientProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();

  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [busy, setBusy] = useState<{ id: string; action: TemplateAction } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function reload() {
    try {
      const { episodes: next } = await apiGet<{ episodes: EpisodeSummary[] }>("/api/episodes");
      setEpisodes(next);
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

      const { episode } = await apiSend<{ episode: EpisodeRecord }>("/api/episodes", "POST", {
        templateId: template.id,
      });

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
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Scenarios"
        subtitle="A scenario is one simulated workday inside a cloned business: who works there, what happens and when, and what counts as having done the job."
        actions={
          <Button
            variant="primary"
            size="lg"
            icon={<IconSpark size={14} />}
            onClick={(e) => go(e, "/scenarios/new")}
          >
            New scenario
          </Button>
        }
      />

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-[26px] text-sn-ink">Saved scenarios</h2>
          {episodes.length > 0 ? (
            <span className="text-[12px] text-sn-subtle">
              {episodes.length} saved on this machine
            </span>
          ) : null}
        </div>

        <div className="mt-5">
          {episodes.length === 0 ? (
            <EmptyState
              icon={<IconLayers size={20} />}
              title="Nothing saved yet"
              description="Create one from scratch, or save a template below as a starting point. Either way you get a whole fake company — an inbox, Slack channels and a calendar, with the same people in all three."
              hints={[
                "Describe the business in a sentence and watch it become a working day",
                "Every scenario carries its own success criteria, so a run always has a score",
                "Nothing leaves this machine and no real account is ever touched",
              ]}
              action={
                <Button variant="primary" icon={<IconSpark size={14} />} onClick={(e) => go(e, "/scenarios/new")}>
                  Describe a business
                </Button>
              }
            />
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              {episodes.map((episode) => (
                <SavedScenarioCard
                  key={episode.id}
                  episode={episode}
                  deleting={deleting === episode.id}
                  onDelete={(target) => void onDelete(target)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="font-display text-[26px] text-sn-ink">Templates</h2>
        <p className="mt-1.5 max-w-[68ch] text-[13.5px] leading-[21px] text-sn-muted">
          The five days the benchmark runs. Each one is written so it cannot be solved by reading a
          single message — the fact the agent needs is always on a different surface from the place
          it is asked for, and the day keeps changing after the agent starts working.
        </p>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              busy={busy?.id === template.id ? busy.action : null}
              onAction={(target, action) => void onTemplateAction(target, action)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
