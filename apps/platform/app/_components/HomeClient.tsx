"use client";

import {
  buttonClasses,
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
import { useSimulated } from "./useSimulated";
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

/**
 * The footnote under the headline number: who is in the mean, and who is not.
 *
 * The two exclusions are named apart because they are different admissions. A
 * run that never ran is a fact about that run. A run the stand-in fabricated is a
 * fact about this product — it was in this mean until someone checked — and
 * folding it into "never ran" would let the second hide inside the first on the
 * one card that is read on every visit.
 */
function autonomyHint(stats: Overview["stats"], simulated: number): string {
  if (stats.scored === 0) {
    return simulated > 0
      ? `How much gets done without a human. Nothing real has been scored yet — the ${simulated} saved run${simulated === 1 ? "" : "s"} here ${simulated === 1 ? "was" : "were"} simulated, with no model behind ${simulated === 1 ? "it" : "them"}.`
      : "How much gets done without a human. Nothing scored yet.";
  }

  // Rows with no score, less the fabricated ones already named. Clamped because
  // the two counts come from different stores — the rows and the artifacts — and
  // a negative remainder would be a worse sentence than a missing one.
  const never = Math.max(stats.unscored - simulated, 0);
  const notes = [
    ...(simulated > 0
      ? [
          `${simulated} ${simulated === 1 ? "was" : "were"} simulated — no model was ever called, so ${simulated === 1 ? "it is" : "they are"} not counted`,
        ]
      : []),
    ...(never > 0 ? [`${never} more never ran, so ${never === 1 ? "it is" : "they are"} not counted`] : []),
  ];

  return (
    `Mean across ${stats.scored} scored ${stats.scored === 1 ? "run" : "runs"} — mixes scenarios and models` +
    notes.map((note) => ` · ${note}`).join("")
  );
}

export function HomeClient({ initial }: HomeClientProps) {
  const go = useGo();
  const poll = usePoll<Overview>("/api/overview", 2500, initial);
  const { data, refresh } = poll;
  const { counts, stats, live, recent, twins } = data;
  const simulated = useSimulated();

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
        // Only while a day is playing. With nothing running, the card directly
        // below is itself a "New run" button — the page was offering the same
        // action twice within one glance, which reads as two different actions.
        //
        // A real anchor wearing the button's clothes: the page's main exit has
        // to survive middle-click and "copy link address".
        actions={
          live.length > 0 ? (
            <a
              href={ROUTES.runs}
              onClick={(e) => go(e, ROUTES.runs)}
              className={buttonClasses("primary", "md")}
            >
              New run
              <IconArrowRight size={14} />
            </a>
          ) : undefined
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
                {/* No clock here on purpose. This said "starts at 9am and runs
                    24 fifteen-minute ticks" while the start time came from
                    Settings, the length came from the scenario, and the run
                    panel offered four lengths — three numbers, none of them
                    this one. The panel states the day it is about to buy, in
                    ticks and in dollars; a card with no run in front of it has
                    nothing to be specific about. */}
                <p className="mt-1 max-w-[54ch] text-[13px] leading-[20px] text-sn-muted">
                  Pick a company, a scenario and a model. The run panel prices every length
                  before you start one. Watch the day here, or inside Gmail, Slack and Calendar
                  as it happens.
                </p>
              </div>
            </div>
            <a
              href={ROUTES.runs}
              onClick={(e) => go(e, ROUTES.runs)}
              className={buttonClasses("primary", "md")}
            >
              New run
            </a>
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
            // The mean is over the runs that produced a result. Runs that never
            // executed, and runs no model ever touched, are named rather than
            // averaged in — the counts are the honest footnote to the number
            // beside them. And a mean over unlike scenarios and models is barely
            // a quantity, so it says so.
            hint={autonomyHint(stats, simulated.size)}
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
            // The total counts everything on disk, fabricated days included —
            // deleting them from the tally is how they got averaged in unnoticed.
            // It just has to say how many of them there are.
            hint={
              `${counts.worlds} ${counts.worlds === 1 ? "company" : "companies"} · ${counts.episodes} ${
                counts.episodes === 1 ? "scenario" : "scenarios"
              }` + (simulated.size > 0 ? ` · ${simulated.size} simulated` : "")
            }
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

      <RecentRuns runs={recent} now={data.at} simulated={simulated} />

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
