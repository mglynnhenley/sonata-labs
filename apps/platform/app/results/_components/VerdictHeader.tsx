"use client";

import { NO_RESULT } from "@sonata/core";
import {
  Badge,
  Card,
  IconAlert,
  IconBolt,
  IconClock,
  IconLayers,
  ProgressBar,
  StatCard,
} from "@sonata/ui";
import {
  badgeStatus,
  CHECKLIST_HINT,
  CHECKLIST_LABEL,
  formatDuration,
  formatPercent,
  formatUsd,
  formatWhen,
  outcomeLabel,
  type RunSummary,
} from "../_lib/summary";
import { SIMULATED_LABEL } from "../_lib/simulated";
import type { ReplayStats } from "../_lib/moments";
import { judgeCopy, judgeStateLabel } from "./judgeCopy";
import { useJudgeState } from "./judgeState";

// The verdict, at the top, big. Autonomy is the number the benchmark is about,
// so it gets the display face and the whole left column; everything beside it is
// a door into the section that proves it.

export type Section = "checklist" | "failures" | "replay" | "cost";

function autonomyTone(value: number | null): "success" | "gold" | "danger" {
  if (value === null) return "gold";
  return value >= 0.75 ? "success" : value >= 0.4 ? "gold" : "danger";
}

/**
 * What the percentage leaves out, said in the hint rather than left to arithmetic
 * on the reader's part. Undecided `must`s are named first because they are the
 * reason the verdict beside this card says "Inconclusive".
 */
function coverageHint(
  coverage: RunSummary["coverage"],
): string | undefined {
  if (!coverage || coverage.decided === coverage.total) return undefined;
  const undecided = coverage.total - coverage.decided;
  const musts =
    coverage.undecidedMusts > 0
      ? ` ${coverage.undecidedMusts} of them ${coverage.undecidedMusts === 1 ? "is a" : "are"} must-do${coverage.undecidedMusts === 1 ? "" : "s"}, so this run has not been graded — the percentage is what the harness could see, not what happened.`
      : "";
  return (
    `Weighted share of the ${coverage.decided} criteria this run settled. ` +
    `${undecided} of ${coverage.total} could not be checked at all and are in neither half of ` +
    `the fraction.${musts}`
  );
}

export function VerdictHeader({
  summary,
  stats,
  costUsd,
  judgeAutonomy,
  error,
  onOpen,
}: {
  summary: RunSummary;
  stats: ReplayStats;
  costUsd: number | null;
  /**
   * The judge's own autonomy figure, which is arrived at independently of the
   * deterministic one above it. Null when nothing has judged the run.
   */
  judgeAutonomy: number | null;
  /** Set when the run itself fell over — shown above everything else. */
  error?: string;
  onOpen: (section: Section) => void;
}) {
  const autonomy = summary.autonomy;
  const coverage = summary.coverage;
  const judgeState = useJudgeState();
  const criticalCount = summary.failures.filter((f) => f.severity === "critical").length;
  // Two DIFFERENT measures of the same day, not two attempts at one: arithmetic
  // over what the run did, and a model's opinion of it. Both are kept on purpose
  // — a wide gap means the catalog is missing the mode the judge is reacting to.
  //
  // Stated in whole points, always, and never as agreement. This card used to
  // call anything inside 20 points "they agree", which printed 63% and 45% under
  // the word "agree"; the reader's own eyes were the counter-evidence.
  const gapPoints =
    autonomy !== null && judgeAutonomy !== null
      ? Math.abs(Math.round(autonomy * 100) - Math.round(judgeAutonomy * 100))
      : null;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2.5 rounded-sn-xl border border-sn-failed-line bg-sn-failed-soft px-4 py-3 text-[13px] text-sn-failed-ink">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">The run ended badly.</span> {error}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {summary.noResult ? (
          // No number at all, and the reason in its place. A 0% here would be a
          // claim about the model; the truth is a claim about this run, and the
          // reader has to be able to tell the two apart at a glance.
          <Card padding="lg" radius="2xl" className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
                  Autonomy
                </span>
                <Badge status="neutral" size="sm">
                  {summary.simulated ? SIMULATED_LABEL : NO_RESULT}
                </Badge>
              </div>
              <p className="mt-4 font-display-upright text-[34px] leading-[1.1] text-sn-ink">
                {summary.simulated ? "Simulated" : "No result"}
              </p>
              <p className="mt-3 text-[12.5px] leading-[19px] text-sn-muted">{summary.noResult}</p>
              <p className="mt-3 text-[12.5px] leading-[19px] text-sn-subtle">
                {summary.simulated
                  ? // Kept, not hidden: the replay below is a real record of what the
                    // dashboard once showed the owner as a measurement, and deleting it
                    // would make the product look cleaner than it was.
                    "It is in no mean and no table. The day below is still worth reading — it is " +
                      "exactly what this product used to present as a result."
                  : "Nothing is scored from a day like this — not zero, nothing. It is left out of " +
                    "every mean and every table, and the day below is all there is to read."}
              </p>
            </div>
            <p className="mt-5 border-t border-sn-line pt-3.5 text-[12px] text-sn-muted">
              {stats.ticks} tick{stats.ticks === 1 ? "" : "s"} recorded · {stats.toolCalls} tool
              call{stats.toolCalls === 1 ? "" : "s"}
            </p>
          </Card>
        ) : (
        <Card padding="lg" radius="2xl" className="flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
                Autonomy
              </span>
              <Badge status={badgeStatus(summary)} size="sm">
                {outcomeLabel(summary)}
              </Badge>
            </div>

            <button
              type="button"
              onClick={() => onOpen("checklist")}
              className="mt-2 flex w-full items-end gap-1 rounded-sn-md text-left"
              aria-label="See the criteria behind this score"
            >
              <span
                data-numeric
                className="font-display-upright text-[76px] leading-[0.85] text-sn-ink"
              >
                {autonomy === null ? "—" : Math.round(autonomy * 100)}
              </span>
              {autonomy === null ? null : (
                <span className="pb-2 text-[26px] leading-none text-sn-muted">%</span>
              )}
            </button>

            <ProgressBar
              className="mt-4"
              value={(autonomy ?? 0) * 100}
              tone={autonomyTone(autonomy)}
              size="md"
            />
            <p className="mt-3 text-[12.5px] leading-[19px] text-sn-muted">
              How much of the job got done without a human stepping in, counted off the day
              itself.{" "}
              <button
                type="button"
                onClick={() => onOpen("checklist")}
                className="text-sn-primary-ink underline underline-offset-2"
              >
                See the criteria
              </button>
              .
            </p>

            {/* The number stays; the claim next to it does not. A run whose
                must-dos nobody could check has a percentage and no verdict, and
                the difference between those two things is the whole point of
                this notice — without it the reader reads the number as a grade. */}
            {summary.outcome === "inconclusive" ? (
              <p className="mt-3 rounded-sn-lg border border-sn-line bg-sn-bg-subtle px-3 py-2.5 text-[12px] leading-[18px] text-sn-muted">
                <span className="font-medium text-sn-ink">This run has no verdict.</span>{" "}
                {coverage && coverage.undecidedMusts > 0
                  ? `${coverage.undecidedMusts} of the day's must-dos could not be checked at all, so nothing here shows whether the job was done. `
                  : "Nothing on this day's checklist could be settled either way, so nothing here shows whether the job was done. "}
                The percentage above is a reading over the part of the day the harness could see.
                Read the findings below instead.
              </p>
            ) : null}
          </div>

          {judgeAutonomy === null ? null : (
            <div className="mt-5 border-t border-sn-line pt-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-sn-muted">The judge&rsquo;s own reading</span>
                <span data-numeric className="text-[15px] font-medium text-sn-ink">
                  {formatPercent(judgeAutonomy)}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-[16px] text-sn-subtle">
                {gapPoints === null
                  ? null
                  : gapPoints === 0
                    ? "A different measure, at the same number: the figure above is arithmetic over the day's shape, this one is a model's opinion after reading it."
                    : `A different measure, ${gapPoints} point${gapPoints === 1 ? "" : "s"} apart. The figure above is arithmetic over the day's shape — what got done, how often it acted rather than asked, how much of the day it spent silent. This one is a model's opinion after reading the same day.`}
                {gapPoints !== null && gapPoints >= 20
                  ? " A gap this wide usually means the judge saw something the catalog has no name for yet."
                  : null}
              </p>
            </div>
          )}
        </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The percentage never renders on its own. `unit` carries the
              denominator, so "100%" arrives as "100% · 1 of 4 decided" — the
              reader can see it is a reading over part of the day before they can
              read it as a grade. */}
          <StatCard
            label={CHECKLIST_LABEL}
            value={formatPercent(summary.score)}
            unit={coverage ? `of ${coverage.decided} decided, ${coverage.total} asked` : undefined}
            hint={
              summary.simulated
                ? "No criterion was checked. The day this checklist was scored against was scripted, so a pass here would have been a reading of the script."
                : summary.noResult
                  ? "No criterion was checked: a checklist run against a day the agent never worked scores its negative criteria for free."
                  : coverageHint(coverage) ?? CHECKLIST_HINT
            }
            icon={<IconLayers size={15} />}
            actionLabel="See the checklist"
            onClick={() => onOpen("checklist")}
          />
          {/* An un-diagnosed run says WHICH kind of un-diagnosed it is. "Not
              judged" on its own was the same two words for a pass in flight, a
              pass that fell over, and a day with nothing in it to read. */}
          <StatCard
            label="Failure modes"
            value={summary.judged ? summary.failures.length : "—"}
            unit={summary.judged ? undefined : judgeStateLabel(judgeState)}
            hint={
              summary.judged
                ? criticalCount > 0
                  ? `${criticalCount} critical. Open one to jump to the moment.`
                  : "Open one to jump to the moment it happened."
                : judgeCopy(judgeState).detail
            }
            icon={<IconAlert size={15} />}
            actionLabel="See the findings"
            onClick={() => onOpen("failures")}
          />
          {/* The hint still names no role by name — the breakdown below names the
              ones actually in it. It no longer says "what the RUN spent", though:
              the judge now meters itself onto the same trace, so this figure
              covers the reading of the day as well as the day. */}
          <StatCard
            label="Cost"
            value={formatUsd(costUsd)}
            hint="Every model call filed against this run, the judge's included. Open it for the per-role split."
            icon={<IconBolt size={15} />}
            actionLabel="See the per-call breakdown"
            onClick={() => onOpen("cost")}
          />
          <StatCard
            label="The day"
            value={formatDuration(summary.durationMs)}
            hint={`${stats.ticks} tick${stats.ticks === 1 ? "" : "s"} · ${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"} · ${stats.mutations} change${stats.mutations === 1 ? "" : "s"}`}
            icon={<IconClock size={15} />}
            actionLabel="Replay the day"
            onClick={() => onOpen("replay")}
          />
        </div>
      </div>

      <p className="text-[12px] text-sn-subtle">
        Started {formatWhen(summary.startedAt)} · run id{" "}
        <span className="font-mono text-[11.5px]">{summary.runId}</span>
      </p>
    </div>
  );
}
