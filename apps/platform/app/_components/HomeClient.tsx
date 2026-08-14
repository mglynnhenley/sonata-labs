"use client";

import {
  buttonClasses,
  IconArrowRight,
  PageHeader,
  StatCard,
} from "@sonata/ui";
import { ago, percent } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { Overview } from "@/lib/overview";
// The names live with the projections that produce the numbers, so Home and the
// results pages cannot spell the same metric two ways.
import { PASS_RATE_HINT, PASS_RATE_LABEL } from "../results/_lib/summary";
import { FirstRun } from "./FirstRun";
import { useSimulated } from "./useSimulated";
import { RecentRuns } from "./RecentRuns";
import { QueueHealth } from "./QueueHealth";
import { UnderTest } from "./UnderTest";
import { RunningCard } from "./RunningCard";
import { StaleNotice } from "./StaleNotice";
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
  // The hint clamps to two lines at 11px. The old version wrote three clauses
  // into it — the mean, then why the simulated runs are excluded, then why the
  // unstarted ones are — and the reader saw "mixes scenarios and models • 8
  // were simulated …", a sentence cut mid-caveat. "Scored" is the caveat: it
  // is the denominator, and it already says the other rows are not in it.
  return `How much gets done without a human. Mean of ${stats.scored} scored ${stats.scored === 1 ? "run" : "runs"}.`;
}

export function HomeClient({ initial }: HomeClientProps) {
  const go = useGo();
  const poll = usePoll<Overview>("/api/overview", 2500, initial);
  const { data, refresh } = poll;
  const { counts, stats, live, recent, twins, clone, medianHorizonMin, simMinutesPerTick } = data;
  const simulated = useSimulated();

  // A real export, so the button is not scenery: the runs on screen, as CSV.
  const exportCsv = () => {
    const head = "run_id,scenario,environment,model,status,autonomy,checklist,started_at\n";
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const body = recent
      .map((run) =>
        [
          run.id,
          esc(run.episodeTitle),
          esc(run.worldName),
          esc(run.model),
          run.status,
          run.autonomy ?? "",
          run.score ?? "",
          new Date(run.startedAt).toISOString(),
        ].join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([head + body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sonata-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (data.firstRun) {
    return <FirstRun twins={twins} onTwinsChanged={refresh} />;
  }

  return (
    <div className="sn-stack-section">
      <PageHeader
        eyebrow="Overview"
        // The dashboard is a view of ONE cloned business, so it says which.
        // Falls back only when nothing is loaded into the clones.
        title={clone ? `${clone.name} clone` : "What's happening"}
        // Status, and only status: what is in the clones and how much is ready
        // to throw at it. This used to also define autonomy, which put a
        // glossary entry 200px above the number it explains and made the most-
        // read line on the product two things at once. The definition now leads
        // the Autonomy card's own hint, directly under the 77%.
        subtitle={
          clone
            ? `Seeded ${ago(clone.seededAt, data.at)} from Gmail, Slack and Calendar · ${counts.episodes} ${counts.episodes === 1 ? "scenario" : "scenarios"} ready`
            : `${counts.episodes} ${counts.episodes === 1 ? "scenario" : "scenarios"} ready · nothing cloned yet`
        }
        actions={
          <>
            <button type="button" onClick={exportCsv} className={buttonClasses("secondary", "md")}>
              Export
            </button>
            <a
              href={ROUTES.runs}
              onClick={(e) => go(e, ROUTES.runs)}
              className={buttonClasses("primary", "md")}
            >
              New run
              <IconArrowRight size="sm" />
            </a>
          </>
        }
      />

      <StaleNotice poll={poll} what="the overview" />

      {live.length > 0 ? (
        <div className="flex flex-col gap-4">
          {live.slice(0, 3).map((run) => (
            <RunningCard key={run.id} run={run} now={data.at} />
          ))}
        </div>
      ) : null}

      <section>
        <h2 className="sr-only">Scores so far</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {/* Runs this week leads, with a real week-over-week arrow: the
              dashboard's first number should be the one that moved. */}
          <StatCard
            label="Runs this week"
            value={stats.thisWeek}
            delta={
              stats.weekDelta === 0
                ? undefined
                : {
                    value: Math.abs(stats.weekDelta),
                    direction: stats.weekDelta > 0 ? "up" : "down",
                    label: "vs the week before",
                  }
            }
            hint={`${counts.runs} in total · ${counts.worlds} ${counts.worlds === 1 ? "company" : "companies"} · ${counts.episodes} ${counts.episodes === 1 ? "scenario" : "scenarios"}`}
            href={ROUTES.runs}
            actionLabel="Every run"
            onClick={(e) => go(e, ROUTES.runs)}
          />
          <StatCard
            label="Autonomy"
            // The number and its unit are separate now: "77" reads as the
            // figure and "%" as its unit, which is how the stat strip is drawn.
            value={stats.autonomy === null ? "—" : Math.round(stats.autonomy * 100)}
            unit={stats.autonomy === null ? undefined : "%"}
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
            hint={
              stats.scored === 0
                ? PASS_RATE_HINT
                : `${PASS_RATE_HINT} ${stats.scored} scored so far.`
            }
            href={ROUTES.compare}
            actionLabel="Which criteria failed"
            onClick={(e) => go(e, ROUTES.compare)}
          />
          {/* How far into a simulated day the typical run gets before it stops.
              Median rather than mean: one run that died on tick 1 should not
              drag the typical day down with it. */}
          <StatCard
            label="Median horizon"
            value={medianHorizonMin === null ? "—" : medianHorizonMin}
            unit={medianHorizonMin === null ? undefined : "min"}
            hint="Simulated time the typical run reaches before it stalls or hands back."
            href={ROUTES.runs}
            actionLabel="Every run"
            onClick={(e) => go(e, ROUTES.runs)}
          />
        </div>
      </section>

      {/* The dashboard shape: what happened on the left, how the benchmark
          itself is doing on the right. One block below the stat strip rather
          than a full section — they are two halves of the same glance. */}
      <div className="-mt-4 grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RecentRuns
          runs={recent}
          now={data.at}
          simulated={simulated}
          simMinutesPerTick={simMinutesPerTick}
        />
        {/* The rail stacks: Queue health alone left 389px of the column empty
            beside a twelve-row table, which reads as a layout that broke
            rather than one that ran out of things to say. */}
        <div className="sn-stack-group">
          <QueueHealth stats={stats} twins={twins} scenarios={counts.episodes} />
          <UnderTest models={data.models} />
        </div>
      </div>

    </div>
  );
}
