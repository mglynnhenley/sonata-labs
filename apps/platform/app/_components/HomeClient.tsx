"use client";

import {
  Button,
  Card,
  IconAlert,
  IconArrowRight,
  IconLayers,
  IconPlay,
  IconSearch,
  IconSpark,
  PageHeader,
  StatCard,
} from "@sonata/ui";
import { money, percent } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { Overview } from "@/lib/overview";
import { FirstRun } from "./FirstRun";
import { QuickStart } from "./QuickStart";
import { RecentRuns } from "./RecentRuns";
import { RunningCard } from "./RunningCard";
import { TwinStrip } from "./TwinStrip";
import { useGo } from "./useGo";
import { usePoll } from "./usePoll";

// Home. Two states out of one payload: a welcome that teaches the product, and
// a live overview that never needs reloading. The server renders the first copy
// so the page is never blank, and the poll takes over from there.

export interface HomeClientProps {
  initial: Overview;
}

export function HomeClient({ initial }: HomeClientProps) {
  const go = useGo();
  const { data, refresh } = usePoll<Overview>("/api/overview", 2500, initial);
  const { counts, stats, live, recent, twins } = data;

  if (data.firstRun) {
    return <FirstRun twins={twins} onTwinsChanged={refresh} />;
  }

  const twinsDown = twins.filter((t) => !t.ok);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="Overview"
        title="What's happening"
        subtitle="Everything running right now, and what the finished days scored."
        actions={
          <Button
            variant="primary"
            iconRight={<IconArrowRight size={14} />}
            onClick={(e) => go(e, ROUTES.runs)}
          >
            Start the day
          </Button>
        }
      />

      {live.length > 0 ? (
        <div className="flex flex-col gap-4">
          {live.slice(0, 3).map((run) => (
            <RunningCard key={run.id} run={run} now={data.at} />
          ))}
        </div>
      ) : (
        <Card padding="lg" tone="outline" className="border-dashed">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sn-gold-soft text-sn-gold-ink">
                <IconSpark size={16} />
              </span>
              <div>
                <p className="text-[14px] font-medium text-sn-ink">Nothing is running</p>
                <p className="mt-1 max-w-[54ch] text-[13px] leading-[20px] text-sn-muted">
                  Pick a scenario and a model, and the workday starts at 9am. You can watch it in
                  this dashboard or inside the clones themselves.
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={(e) => go(e, ROUTES.runs)}>
              Start the day
            </Button>
          </div>
        </Card>
      )}

      <section>
        <h2 className="sr-only">Scores so far</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Autonomy"
            value={percent(stats.autonomy)}
            icon={<IconSpark size={15} />}
            hint={
              stats.finished === 0
                ? "How much gets done without a human. Nothing scored yet."
                : `Mean across ${stats.finished} finished ${stats.finished === 1 ? "run" : "runs"}`
            }
            href={ROUTES.results}
            actionLabel="Open the results and see the criteria behind this"
            onClick={(e) => go(e, ROUTES.results)}
          />
          <StatCard
            label="Task success"
            value={percent(stats.passRate)}
            icon={<IconSearch size={15} />}
            hint="Days where every must-do criterion passed"
            href={ROUTES.results}
            onClick={(e) => go(e, ROUTES.results)}
          />
          <StatCard
            label="Runs"
            value={counts.runs}
            icon={<IconPlay size={13} />}
            hint={`${counts.worlds} ${counts.worlds === 1 ? "world" : "worlds"} · ${counts.episodes} ${
              counts.episodes === 1 ? "scenario" : "scenarios"
            }`}
            href={ROUTES.runs}
            onClick={(e) => go(e, ROUTES.runs)}
          />
          <StatCard
            label="Spend"
            value={money(stats.spendUsd)}
            icon={<IconLayers size={15} />}
            hint="Every model call so far, agent and director"
            href={ROUTES.results}
            onClick={(e) => go(e, ROUTES.results)}
          />
        </div>
      </section>

      <RecentRuns runs={recent} now={data.at} />

      {twinsDown.length > 0 ? (
        <section>
          <div className="flex items-center gap-2">
            <IconAlert size={15} className="text-sn-warning" />
            <h2 className="text-[14px] font-medium text-sn-ink">
              {twinsDown.length === 1
                ? `The ${twinsDown[0].label} clone is not running`
                : `${twinsDown.length} clones are not running`}
            </h2>
          </div>
          <p className="mt-1.5 text-[13px] text-sn-muted">
            A scenario can only use a clone that is up. Start them here.
          </p>
          <div className="mt-4">
            <TwinStrip twins={twins} onChanged={refresh} />
          </div>
        </section>
      ) : null}

      <QuickStart />
    </div>
  );
}
