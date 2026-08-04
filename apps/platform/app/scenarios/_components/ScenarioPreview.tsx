"use client";

import {
  Badge,
  Card,
  Chip,
  IconCalendar,
  IconInfo,
  IconMail,
  IconMessage,
  SERVICE_LABELS,
  Timeline,
  TimelineItem,
} from "@sonata/ui";
import type { ReactNode } from "react";
import type { TwinName } from "@sonata/core";
import { dayRange } from "@/lib/format";
import type { ScenarioDraft, WorldCounts } from "../../api/_lib/types";

// What will be generated, before anything is written. This is the moment the
// product either feels effortless or does not, so it shows the whole thing: the
// company, the people, the channels, every beat of the day and the criteria it
// will be scored against — and the counts here are the counts the seeder writes,
// not an estimate.

const COUNTS: readonly { key: keyof WorldCounts; label: string; twin: TwinName | null }[] = [
  { key: "people", label: "People", twin: null },
  { key: "threads", label: "Email threads", twin: "gmail" },
  { key: "messages", label: "Emails", twin: "gmail" },
  { key: "channels", label: "Slack channels", twin: "slack" },
  { key: "slackMessages", label: "Slack messages", twin: "slack" },
  { key: "events", label: "Meetings", twin: "calendar" },
];

const TWIN_ICON: Record<TwinName, ReactNode> = {
  gmail: <IconMail size={11} />,
  slack: <IconMessage size={11} />,
  calendar: <IconCalendar size={11} />,
};

export type ScenarioPreviewProps = {
  draft: ScenarioDraft;
};

export function ScenarioPreview({ draft }: ScenarioPreviewProps) {
  const { business, counts, cast, channels, episode } = draft;

  return (
    <div className="animate-sn-rise flex flex-col gap-6">
      {draft.offline ? (
        <div className="flex items-start gap-2.5 rounded-sn-lg border border-sn-gold-soft bg-sn-gold-soft px-4 py-3">
          <IconInfo size={15} className="mt-0.5 shrink-0 text-sn-gold-ink" />
          <p className="text-[13px] leading-[20px] text-sn-gold-ink">
            This was built from the closest ready-made day rather than written for your description
            {draft.offlineReason ? ` — ${draft.offlineReason}` : ""}. Fix that and preview again to
            have the company written from scratch.
          </p>
        </div>
      ) : null}

      <Card padding="lg">
        <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
          The business
        </p>
        <h2 className="font-display mt-1.5 text-[34px] text-sn-ink">{business.name}</h2>
        <p className="mt-1 text-[13px] text-sn-subtle">
          {business.industry} · {business.size} people
        </p>
        <p className="mt-3 max-w-[68ch] text-[14px] leading-[22px] text-sn-muted">
          {business.description}
        </p>

        <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-sn-line pt-6 sm:grid-cols-3 lg:grid-cols-6">
          {COUNTS.map((row) => (
            <div key={row.key}>
              <dt className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase">
                {row.twin ? TWIN_ICON[row.twin] : null}
                {row.label}
              </dt>
              <dd data-numeric className="mt-1 text-[28px] leading-none text-sn-ink">
                {counts[row.key]}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card padding="lg" title="The cast" subtitle="The same people appear in all three clones.">
          <ul className="flex flex-col divide-y divide-sn-line">
            {cast.map((person) => (
              <li key={person.id} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-sn-ink">
                    {person.name}
                  </span>
                  <span className="block truncate text-[12px] text-sn-subtle">{person.email}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[12.5px] text-sn-muted">{person.role}</span>
                  <span className="block text-[11.5px] text-sn-subtle">{person.relationship}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          padding="lg"
          title="The channels"
          subtitle="Where the company talks when it is not writing email."
        >
          <ul className="flex flex-col divide-y divide-sn-line">
            {channels.map((channel) => (
              <li key={channel.name} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline gap-3">
                  <span className="text-[13.5px] font-medium text-sn-ink">#{channel.name}</span>
                  <span className="ml-auto shrink-0 text-[11.5px] text-sn-subtle">
                    {channel.memberCount} member{channel.memberCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-0.5 text-[12.5px] leading-[19px] text-sn-muted">{channel.purpose}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card padding="lg">
        <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">The day</p>
        <h3 className="font-display mt-1.5 text-[28px] text-sn-ink">{episode.title}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {episode.twins.map((twin) => (
            <Chip key={twin} service={twin} size="sm">
              {SERVICE_LABELS[twin]}
            </Chip>
          ))}
          <Chip size="sm">
            {dayRange(episode.startISO, episode.simMinutesPerTick, episode.ticks)}
          </Chip>
          <Chip size="sm">{episode.ticks} ticks</Chip>
        </div>
        <p className="mt-4 max-w-[68ch] text-[14px] leading-[22px] text-sn-muted">{episode.story}</p>

        <div className="mt-5 rounded-sn-lg bg-sn-bg-subtle px-4 py-3.5">
          <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
            What the agent will be told
          </p>
          <p className="mt-1.5 text-[13.5px] leading-[21px] text-sn-ink">{episode.task}</p>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card
          padding="lg"
          title="What will happen, and when"
          subtitle="Scripted in advance, so two models get the same day. Everything people say back is improvised as it happens."
        >
          <Timeline aria-label="Scheduled beats">
            {episode.beats.map((beat, index) => (
              <TimelineItem
                key={`${beat.tick}-${index}`}
                time={beat.timeLabel}
                timeMeta={`Tick ${beat.tick}`}
                tone={beat.twin}
                icon={TWIN_ICON[beat.twin]}
                title={beat.summary}
                meta={
                  <Chip service={beat.twin} size="sm">
                    {SERVICE_LABELS[beat.twin]}
                  </Chip>
                }
              />
            ))}
          </Timeline>
        </Card>

        <Card
          padding="lg"
          title="What counts as done"
          subtitle="A must that fails, fails the run. A should only costs score."
        >
          <ul className="flex flex-col divide-y divide-sn-line">
            {episode.criteria.map((criterion, index) => (
              <li key={index} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <Badge
                  status={criterion.severity === "must" ? "warning" : "neutral"}
                  size="sm"
                  className="mt-0.5 shrink-0"
                >
                  {criterion.severity}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] leading-[20px] text-sn-ink">
                    {criterion.description}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-sn-subtle">
                    {criterion.twin === "any" ? "across the whole day" : SERVICE_LABELS[criterion.twin]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
