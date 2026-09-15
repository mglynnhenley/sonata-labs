"use client";

import { LogoDesk, LogoExcel, Badge, Card, Chip, IconInfo, LogoAttio, LogoGmail, LogoGoogleAds, LogoGoogleCalendar, LogoGoogleDocs, LogoLinkedIn, LogoSlack, SERVICE_LABELS, Timeline, TimelineItem } from "@sonata/ui";
import type { ReactNode } from "react";
import type { TwinName } from "@sonata/core";
import { dayRange } from "@/lib/format";
import type { ScenarioDraft, WorldCounts } from "../../api/_lib/types";

// Expectations stay in the main reading path. Cast and event details are
// available on demand; all counts come from the draft rather than forecasts.

const WORLD_COUNTS: readonly { key: keyof WorldCounts; label: string; twin: TwinName | null }[] = [
  { key: "people", label: "People", twin: null },
  { key: "channels", label: "Slack channels", twin: "slack" },
  { key: "workbooks", label: "Workbooks", twin: "excel" },
];

const DAY_COUNTS: readonly { key: keyof WorldCounts; label: string; twin: TwinName }[] = [
  { key: "messages", label: "Emails arrive", twin: "gmail" },
  { key: "slackMessages", label: "Slack messages", twin: "slack" },
  { key: "events", label: "Meetings land", twin: "calendar" },
];

const TWIN_ICON: Record<TwinName, ReactNode> = {
  gmail: <LogoGmail size={11} />,
  slack: <LogoSlack size={11} />,
  calendar: <LogoGoogleCalendar size={11} />,
  attio: <LogoAttio size={11} />,
  "google-docs": <LogoGoogleDocs size={11} />,
  "google-ads": <LogoGoogleAds size={11} />,
  linkedin: <LogoLinkedIn size={11} />,
  excel: <LogoExcel size={11} />,
  desk: <LogoDesk size={11} />,
};

export type ScenarioPreviewProps = {
  draft: ScenarioDraft;
};

function Stat({ label, twin, value }: { label: string; twin: TwinName | null; value: number }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-sn-xs font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {twin ? TWIN_ICON[twin] : null}
        {label}
      </dt>
      <dd data-numeric className="mt-1 text-sn-3xl leading-none text-sn-ink">
        {value}
      </dd>
    </div>
  );
}

export function ScenarioPreview({ draft }: ScenarioPreviewProps) {
  const { business, counts, cast, channels, episode } = draft;
  // A substitution is only a substitution when something was described. Choosing
  // a template card is also `offline`, and nobody needs telling that the day they
  // picked is the day they picked; `offlineReason` is set only when a brief was
  // answered with somebody else's company.
  const standIn = draft.offline && draft.offlineReason ? draft.offlineReason : null;

  return (
    <div className="animate-sn-rise flex flex-col gap-6">
      <Card padding="lg">
        <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
          Environment · where the agent works
        </p>
        <h2 className="font-display mt-1.5 text-sn-3xl text-sn-ink">{business.name}</h2>
        <p className="mt-1 text-sn-base text-sn-subtle">
          {business.industry} · {business.size} people
        </p>

        {/* Beside the name, above the description, because that is where someone
            reads what company this is. Underneath the whole preview it was a
            footnote, and a footnote is how "we used a template" got read as
            "here is your business". */}
        {standIn ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-sn-lg border border-sn-gold-soft bg-sn-gold-soft px-4 py-3">
            <IconInfo size="md" className="mt-0.5 shrink-0 text-sn-gold-ink" />
            <div className="min-w-0">
              <p className="text-sn-base font-medium text-sn-gold-ink">
                {business.name} is a ready-made example, not the business you described.
              </p>
              <p className="mt-1 text-sn-base text-sn-gold-ink">{standIn}</p>
              <p className="mt-2 text-sn-sm leading-[19px] text-sn-gold-ink/85">
                You described: “{draft.brief}”. Everything below belongs to the example — the
                people, the day and what it is scored on. Save it only if running that company is
                what you want.
              </p>
            </div>
          </div>
        ) : null}

        <p className="mt-3 max-w-[68ch] text-sn-md text-sn-muted">
          {business.description}
        </p>

      </Card>

      <Card padding="lg">
        <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">Scenario · what happens</p>
        <h3 className="font-display mt-1.5 text-sn-3xl text-sn-ink">{episode.title}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {episode.twins.map((twin) => (
            <Chip key={twin} service={twin} size="sm">
              {SERVICE_LABELS[twin]}
            </Chip>
          ))}
          <Chip size="sm">
            {dayRange(episode.startISO, episode.simMinutesPerTick, episode.ticks)}
          </Chip>
        </div>
        <p className="mt-4 max-w-[68ch] text-sn-md text-sn-muted">{episode.story}</p>

        <div className="mt-5 rounded-sn-lg bg-sn-bg-subtle px-4 py-3.5">
          <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
            The agent’s task
          </p>
          <p className="mt-1.5 text-sn-base text-sn-ink">{episode.task}</p>
        </div>
      </Card>

        <Card
          padding="lg"
          title="Rubric · what success looks like"
          subtitle="These are the proposed expectations for grading. Review and edit their checks after saving."
        >
          <p className="mb-4 text-sn-sm text-sn-subtle">
            A failed required expectation fails the run. Scored expectations affect the score.
          </p>
          {episode.criteria.length === 0 ? (
            <p className="text-sn-base text-sn-muted">No rubric items were proposed. Add expectations after saving before running this scenario.</p>
          ) : null}
          <ul className="flex flex-col divide-y divide-sn-line">
            {episode.criteria.map((criterion, index) => (
              <li key={index} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <Badge
                  status={criterion.severity === "must" ? "warning" : "neutral"}
                  size="sm"
                  className="mt-0.5 shrink-0"
                >
                  {criterion.severity === "must" ? "Required" : "Scored"}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-sn-base text-sn-ink">
                    {criterion.description}
                  </span>
                  <span className="mt-0.5 block text-sn-xs text-sn-subtle">
                    {criterion.twin === "any" ? "across the whole day" : SERVICE_LABELS[criterion.twin]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

      <details className="rounded-sn-xl border border-sn-line bg-sn-surface p-5">
        <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">
          Explore the environment · {cast.length} people, {channels.length} Slack channels
        </summary>
        <div className="mt-5 grid gap-x-10 gap-y-6 border-t border-sn-line pt-6 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
          <section>
            <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Who is in it
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-5">
              {WORLD_COUNTS.map((row) => (
                <Stat key={row.key} label={row.label} twin={row.twin} value={counts[row.key] ?? 0} />
              ))}
            </dl>
          </section>

          <section>
            <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
              What the day itself delivers
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              {DAY_COUNTS.map((row) => (
                <Stat key={row.key} label={row.label} twin={row.twin} value={counts[row.key] ?? 0} />
              ))}
            </dl>
          </section>
        </div>

        <p className="mt-6 max-w-[76ch] text-sn-sm leading-[19px] text-sn-subtle">
          Background emails, messages and meetings are created when the environment is prepared
          for a run. Their counts are not included in this draft.
        </p>
        <div className="mt-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card padding="lg" title="People" subtitle="The people the agent will work with across the environment.">
          <ul className="flex flex-col divide-y divide-sn-line">
            {cast.map((person) => (
              <li key={person.id} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sn-base font-medium text-sn-ink">
                    {person.name}
                  </span>
                  <span className="block truncate text-sn-sm text-sn-subtle">{person.email}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sn-sm text-sn-muted">{person.role}</span>
                  <span className="block text-sn-xs text-sn-subtle">{person.relationship}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          padding="lg"
          title="Slack channels"
          subtitle="Where the company talks when it is not writing email."
        >
          <ul className="flex flex-col divide-y divide-sn-line">
            {channels.map((channel) => (
              <li key={channel.name} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline gap-3">
                  <span className="text-sn-base font-medium text-sn-ink">#{channel.name}</span>
                  <span className="ml-auto shrink-0 text-sn-xs text-sn-subtle">
                    {channel.memberCount} member{channel.memberCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-0.5 text-sn-sm leading-[19px] text-sn-muted">{channel.purpose}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

        </div>
      </details>

      <details className="rounded-sn-xl border border-sn-line bg-sn-surface p-5">
        <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">
          See scheduled events · {episode.beats.length} events
        </summary>
        <div className="mt-5">
        <Card
          padding="lg"
          title="What will happen, and when"
          subtitle="These scheduled events are shared across runs. Responses during a run may vary."
        >
          <Timeline aria-label="Scheduled beats">
            {episode.beats.map((beat, index) => (
              <TimelineItem
                key={`${beat.tick}-${index}`}
                time={beat.timeLabel}
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

        </div>
      </details>
    </div>
  );
}
