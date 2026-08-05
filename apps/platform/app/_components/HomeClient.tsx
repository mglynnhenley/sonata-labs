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
// The names live with the projections that produce the numbers, so Home and the
// results pages cannot spell the same metric two ways.
import { PASS_RATE_HINT, PASS_RATE_LABEL } from "../results/_lib/summary";
import { FirstRun } from "./FirstRun";
import { QuickStart } from "./QuickStart";
import { RecentRuns } from "./RecentRuns";
import { RunningCard } from "./RunningCard";
import { StaleNotice } from "./StaleNotice";
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
  const poll = usePoll<Overview>("/api/overview", 2500, initial);
  const { data, refresh } = poll;
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
        // Permanent, and never a status line: the most-read sentence on the
        // most-visited page defines the product's central word on every visit.
        subtitle="Autonomy is the share of the day's work your agent finished without handing it back to a human."
        actions={
          <Button
            variant="primary"
            iconRight={<IconArrowRight size={14} />}
            onClick={(e) => go(e, ROUTES.runs)}
          >
            New run
          </Button>
        }
      />

      <StaleNotice poll={poll} what="the overview" />

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
                  Pick a company, a scenario and a model. The workday starts at 9am and runs 24
                  fifteen-minute ticks. Watch it here, or inside Gmail, Slack and Calendar as it
                  happens.
                </p>
              </div>
            </div>
            <Button variant="primary" onClick={(e) => go(e, ROUTES.runs)}>
              New run
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
              // The mean is over the runs that produced a result. Runs that never
              // executed are named rather than averaged in — the count is the
              // honest footnote to the number beside it. And a mean over unlike
              // scenarios and models is barely a quantity, so it says so.
              stats.scored === 0
                ? "How much gets done without a human. Nothing scored yet."
                : `Mean across ${stats.scored} scored ${stats.scored === 1 ? "run" : "runs"} — mixes scenarios and models` +
                  (stats.unscored > 0
                    ? ` · ${stats.unscored} more never ran, so ${stats.unscored === 1 ? "it is" : "they are"} not counted`
                    : "")
            }
            href={ROUTES.compare}
            actionLabel="Compare properly, model by scenario"
            onClick={(e) => go(e, ROUTES.compare)}
          />
          {/* A share of RUNS, not of criteria. It was called "task success", and
              so was the run page's share of ONE run's checklist — one label over
              two denominators, which is how this card read 0% beside a run page
              reading 25% for the same day. */}
          <StatCard
            label={PASS_RATE_LABEL}
            // "0 of 7", never "0%": a low share of runs passing is the finding,
            // but a bare zero percent reads as a broken build rather than early
            // data. The denominator keeps it honest in both directions.
            value={
              stats.passRate === null
                ? percent(null)
                : `${Math.round(stats.passRate * stats.scored)} of ${stats.scored}`
            }
            icon={<IconSearch size={15} />}
            hint={
              stats.scored === 0
                ? PASS_RATE_HINT
                : `${PASS_RATE_HINT} ${stats.scored} scored so far.`
            }
            href={ROUTES.compare}
            actionLabel="Which criteria failed"
            onClick={(e) => go(e, ROUTES.compare)}
          />
          <StatCard
            label="Runs"
            value={counts.runs}
            icon={<IconPlay size={13} />}
            hint={`${counts.worlds} ${counts.worlds === 1 ? "company" : "companies"} · ${counts.episodes} ${
              counts.episodes === 1 ? "scenario" : "scenarios"
            }`}
            href={ROUTES.runs}
            actionLabel="Every run"
            onClick={(e) => go(e, ROUTES.runs)}
          />
          <StatCard
            label="Spend"
            value={money(stats.spendUsd)}
            icon={<IconLayers size={15} />}
            hint="Every model call so far, agent and director"
            href={ROUTES.compare}
            actionLabel="Where the money went"
            onClick={(e) => go(e, ROUTES.compare)}
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
                ? `${twinsDown[0].label} is not running`
                : `${twinsDown.map((t) => t.label).join(" and ")} are not running`}
            </h2>
          </div>
          <p className="mt-1.5 text-[13px] text-sn-muted">
            A scenario can only use an app that is up. Start them here.
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
