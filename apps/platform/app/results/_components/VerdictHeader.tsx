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

// Lead with the declared task requirements. Legacy activity/autonomy heuristics
// remain inspectable, but cannot establish that human review was inappropriate.

export type Section = "checklist" | "failures" | "replay" | "cost";

function scoreTone(value: number | null): "success" | "gold" | "danger" {
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
      ? ` ${coverage.undecidedMusts} of those ${coverage.undecidedMusts === 1 ? "is a" : "are"} must-do${coverage.undecidedMusts === 1 ? "" : "s"}, so this run is not graded: the percentage is what the harness could see, not what happened.`
      : "";
  return (
    `Weighted share of the ${coverage.decided} criteria this run settled. ` +
    `The other ${undecided} of ${coverage.total} could not be checked at all, and count neither ` +
    `way.${musts}`
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
  const score = summary.score;
  const coverage = summary.coverage;
  const judgeState = useJudgeState();
  const criticalCount = summary.failures.filter((f) => f.severity === "critical").length;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="flex items-start gap-2.5 rounded-sn-xl border border-sn-failed-line bg-sn-failed-soft px-4 py-3 text-sn-base text-sn-failed-ink">
          <IconAlert size="md" className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Execution interrupted.</span> {error}
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
                <span className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
                  Run validity
                </span>
                <Badge status="neutral" size="sm">
                  {summary.simulated ? SIMULATED_LABEL : NO_RESULT}
                </Badge>
              </div>
              <p className="mt-4 font-display-upright text-sn-3xl leading-[1.1] text-sn-ink">
                {summary.simulated ? "Simulated" : "No result"}
              </p>
              <p className="mt-3 text-sn-sm leading-[19px] text-sn-muted">{summary.noResult}</p>
              <p className="mt-3 text-sn-sm leading-[19px] text-sn-subtle">
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
            <p className="mt-5 border-t border-sn-line pt-3.5 text-sn-sm text-sn-muted">
              {stats.ticks} tick{stats.ticks === 1 ? "" : "s"} recorded · {stats.toolCalls} tool
              call{stats.toolCalls === 1 ? "" : "s"}
            </p>
          </Card>
        ) : (
        <Card padding="lg" radius="2xl" className="flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
                Checklist score
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
                className="font-display-upright text-sn-6xl leading-[0.85] text-sn-ink"
              >
                {score === null ? "—" : Math.round(score * 100)}
              </span>
              {score === null ? null : (
                <span className="pb-2 text-sn-2xl leading-none text-sn-muted">%</span>
              )}
            </button>

            <ProgressBar
              className="mt-4"
              value={(score ?? 0) * 100}
              tone={scoreTone(score)}
              size="md"
            />
            <p className="mt-3 text-sn-sm leading-[19px] text-sn-muted">
              Weighted success on the criteria this run could check. Required human review
              and justified pending work are assessed against the task.{" "}
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
              <p className="mt-3 rounded-sn-lg border border-sn-line bg-sn-bg-subtle px-3 py-2.5 text-sn-sm text-sn-muted">
                <span className="font-medium text-sn-ink">
                  This run has no verdict. Read the findings below, not the number above.
                </span>{" "}
                {coverage && coverage.undecidedMusts > 0
                  ? `${coverage.undecidedMusts} of the day's must-dos could not be checked at all.`
                  : "Nothing on this day's checklist could be settled either way."}{" "}
                The percentage covers only the part of the day the harness could see.
              </p>
            ) : null}
          </div>

          <details className="mt-5 border-t border-sn-line pt-3.5 text-sn-sm text-sn-muted">
            <summary className="cursor-pointer">Legacy activity measures</summary>
            <p className="mt-2">
              Autonomy heuristic: {formatPercent(summary.autonomy)}.
              {judgeAutonomy !== null ? ` Assessor autonomy opinion: ${formatPercent(judgeAutonomy)}.` : ""}
            </p>
            <p className="mt-1 text-sn-xs text-sn-subtle">
              These measures mix completion, activity and escalation signals. They do not
              establish whether waiting or asking for required review was appropriate.
              Use the task criteria and evidence to assess that.
            </p>
          </details>
        </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The percentage never renders on its own. `unit` carries the
              denominator, so "100%" arrives as "100% · 1 of 4 decided" — the
              reader can see it is a reading over part of the day before they can
              read it as a grade. */}
          <StatCard
            label="Criteria checked"
            value={coverage?.decided ?? "—"}
            unit={coverage ? `of ${coverage.total} declared` : undefined}
            hint={
              summary.simulated
                ? "No criterion was checked. The day this checklist was scored against was scripted, so a pass here would have been a reading of the script."
                : summary.noResult
                  ? "A complete-run score is withheld. Inspect the recorded actions and the interruption before drawing conclusions about the model."
                  : coverageHint(coverage) ?? CHECKLIST_HINT
            }
            icon={<IconLayers size="md" />}
            actionLabel="See the checklist"
            onClick={() => onOpen("checklist")}
          />
          {/* An un-diagnosed run says WHICH kind of un-diagnosed it is. "Not
              judged" on its own was the same two words for a pass in flight, a
              pass that fell over, and a day with nothing in it to read. */}
          <StatCard
            label="Failure modes"
            value={summary.judged ? summary.failures.length : "—"}
            unit={summary.noResult ? "Not scored" : summary.judged ? undefined : judgeStateLabel(judgeState)}
            hint={
              summary.noResult
                ? "This run does not support a complete benchmark verdict. Its recorded actions remain available in the replay."
                : summary.judged
                ? criticalCount > 0
                  ? `${criticalCount} critical. Open one to jump to the moment.`
                  : "Open one to jump to the moment it happened."
                : judgeCopy(judgeState).detail
            }
            icon={<IconAlert size="md" />}
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
            icon={<IconBolt size="md" />}
            actionLabel="See the per-call breakdown"
            onClick={() => onOpen("cost")}
          />
          <StatCard
            label="Recorded elapsed time"
            value={formatDuration(summary.durationMs)}
            hint={`${stats.ticks} tick${stats.ticks === 1 ? "" : "s"} · ${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"} · ${stats.mutations} change${stats.mutations === 1 ? "" : "s"}`}
            icon={<IconClock size="md" />}
            actionLabel="Replay the day"
            onClick={() => onOpen("replay")}
          />
        </div>
      </div>

      <p className="text-sn-sm text-sn-subtle">
        Started {formatWhen(summary.startedAt)} · run id{" "}
        <span className="font-mono text-sn-xs">{summary.runId}</span>
      </p>
    </div>
  );
}
