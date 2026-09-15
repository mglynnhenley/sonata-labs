"use client";

import Link from "next/link";
import { Button, buttonClasses, Card, Chip, IconArrowRight, IconClock, SERVICE_LABELS } from "@sonata/ui";
import type { EpisodeSummary } from "../../api/_lib/types";

// `now` is passed in, never read off the clock here: this card is server-rendered
// and the two machines disagree by enough to change the string between the HTML
// and the hydrated render.
function ago(at: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export type SavedScenarioCardProps = {
  episode: EpisodeSummary;
  expectations: string[];
  /** True for a benchmark day that ships with Sonata — "saved 2 h ago" would
   *  misread as something the user wrote. */
  shipped: boolean;
  /** The server's clock, threaded down rather than read during render. */
  now: number;
  deleting: boolean;
  onDelete: (episode: EpisodeSummary) => void;
};

export function SavedScenarioCard({ episode, expectations, shipped, now, deleting, onDelete }: SavedScenarioCardProps) {
  const lastRun = episode.lastRun;

  return (
    <Card padding="lg" radius="2xl" interactive className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="text-sn-sm text-sn-subtle">Environment · {episode.worldName}</p>
        <h3 className="mt-1 text-sn-md font-bold text-sn-ink">{episode.title}</h3>
        <p className="mt-2 line-clamp-3 text-sn-base text-sn-muted">
          {episode.story}
        </p>

        {expectations.length > 0 ? (
          <div className="mt-4">
            <p className="text-sn-sm font-medium text-sn-ink">Expected behavior</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sn-sm text-sn-muted">
              {expectations.map((expectation, index) => <li key={index}>{expectation}</li>)}
            </ul>
            {episode.counts.criteria > expectations.length ? (
              <p className="mt-1 text-sn-sm text-sn-subtle">
                +{episode.counts.criteria - expectations.length} more in the rubric
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {/* Neutral, not the service hue: twenty cards times three chips is
              seventy pieces of red, purple and blue on one screen, and the
              colour is not the signal — the icon and the word already say which
              app it is. The hue is kept where a chip reports live state (the
              dashboard's cloned systems) and on the scenario detail, where
              there are three of them rather than seventy. */}
          {episode.twins.map((twin) => (
            <Chip key={twin} service={twin} tone="neutral" size="sm">
              {SERVICE_LABELS[twin]}
            </Chip>
          ))}
          <Chip size="sm" icon={<IconClock size="xs" />}>
            {/* Not "beats" (screenwriting jargon the UI never defines) and not
                "ways to pass" — the criteria are conjunctive. */}
            {episode.counts.beats} events · {episode.counts.criteria} rubric items
          </Chip>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {/* The Link IS the button — a `<button>` inside an `<a>` is invalid, and
            it swallowed Cmd-click on the card's way to a run. */}
        <Link
          href={`/scenarios/${encodeURIComponent(episode.id)}`}
          className={buttonClasses("secondary", "sm")}
        >
          Review scenario
          <IconArrowRight size="xs" />
        </Link>
        {lastRun ? (
          <Link href={`/runs/${lastRun.runId}`} className="ml-auto text-sn-sm text-sn-muted hover:underline">
            Last run {ago(lastRun.startedAt, now)}
          </Link>
        ) : (
          <span className="ml-auto text-sn-sm text-sn-subtle">
            {shipped ? "Included scenario" : `Saved ${ago(episode.createdAt, now)}`}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          loading={deleting}
          onClick={() => onDelete(episode)}
          aria-label={`Delete ${episode.title}`}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}
