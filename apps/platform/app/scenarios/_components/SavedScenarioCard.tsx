"use client";

import Link from "next/link";
import { Badge, Button, buttonClasses, Card, Chip, IconClock, IconPlay, SERVICE_LABELS } from "@sonata/ui";
import type { BadgeStatus } from "@sonata/ui";
import type { EpisodeSummary } from "../../api/_lib/types";

const RUN_STATUS: Record<string, BadgeStatus> = {
  queued: "pending",
  running: "running",
  judging: "running",
  done: "passed",
  failed: "failed",
  aborted: "neutral",
};

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
  /** The server's clock, threaded down rather than read during render. */
  now: number;
  deleting: boolean;
  onDelete: (episode: EpisodeSummary) => void;
};

export function SavedScenarioCard({ episode, now, deleting, onDelete }: SavedScenarioCardProps) {
  const lastRun = episode.lastRun;

  return (
    <Card padding="lg" radius="2xl" interactive className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-start gap-3">
          <h3 className="font-display min-w-0 flex-1 text-[23px] text-sn-ink">{episode.title}</h3>
          {lastRun ? (
            <Link href={`/runs/${lastRun.runId}`} className="shrink-0">
              <Badge status={RUN_STATUS[lastRun.status] ?? "neutral"} size="sm">
                {lastRun.score === null
                  ? (RUN_STATUS[lastRun.status] ?? "neutral") === "running"
                    ? "Running"
                    : "No score"
                  : `${Math.round(lastRun.score * 100)}%`}
              </Badge>
            </Link>
          ) : null}
        </div>

        <p className="mt-2 line-clamp-2 text-[13.5px] leading-[21px] text-sn-muted">
          {episode.story}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {episode.twins.map((twin) => (
            <Chip key={twin} service={twin} size="sm">
              {SERVICE_LABELS[twin]}
            </Chip>
          ))}
          <Chip size="sm" icon={<IconClock size={11} />}>
            {/* Not "beats" (screenwriting jargon the UI never defines) and not
                "ways to pass" — the criteria are conjunctive. */}
            {episode.counts.beats} things happen · {episode.counts.criteria} must-dos
          </Chip>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {/* The Link IS the button — a `<button>` inside an `<a>` is invalid, and
            it swallowed Cmd-click on the card's way to a run. */}
        <Link
          href={`/runs?scenario=${encodeURIComponent(episode.id)}`}
          className={buttonClasses("primary", "sm")}
        >
          <IconPlay size={12} />
          Start a run
        </Link>
        <span className="ml-auto text-[12px] text-sn-subtle">
          {lastRun ? `Last run ${ago(lastRun.startedAt, now)}` : `Saved ${ago(episode.createdAt, now)}`}
        </span>
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
