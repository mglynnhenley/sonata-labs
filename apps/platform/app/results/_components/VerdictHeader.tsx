"use client";

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
  formatDuration,
  formatPercent,
  formatUsd,
  formatWhen,
  outcomeLabel,
  type RunSummary,
} from "../_lib/summary";
import type { ReplayStats } from "../_lib/moments";

// The verdict, at the top, big. Autonomy is the number the benchmark is about,
// so it gets the display face and the whole left column; everything beside it is
// a door into the section that proves it.

export type Section = "checklist" | "failures" | "replay" | "cost";

function autonomyTone(value: number | null): "success" | "gold" | "danger" {
  if (value === null) return "gold";
  return value >= 0.75 ? "success" : value >= 0.4 ? "gold" : "danger";
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
  const criticalCount = summary.failures.filter((f) => f.severity === "critical").length;
  // Two independent readings of the same day: the checklist minus autonomy
  // findings, and the judge's own number. @sonata/core keeps both on purpose —
  // a wide gap means the catalog is missing the mode the judge is reacting to.
  const gap =
    autonomy !== null && judgeAutonomy !== null ? Math.abs(autonomy - judgeAutonomy) : null;

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
              How much of the job got done without a human stepping in.{" "}
              <button
                type="button"
                onClick={() => onOpen("checklist")}
                className="text-sn-primary-ink underline underline-offset-2"
              >
                See the criteria
              </button>
              .
            </p>
          </div>

          {judgeAutonomy === null ? null : (
            <div className="mt-5 border-t border-sn-line pt-3.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-sn-muted">The judge scored it</span>
                <span data-numeric className="text-[15px] font-medium text-sn-ink">
                  {formatPercent(judgeAutonomy)}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] leading-[16px] text-sn-subtle">
                {gap !== null && gap >= 0.2
                  ? "The two readings disagree. The number above is derived from the checklist and the autonomy findings; a gap this wide usually means the judge saw something the catalog has no name for yet."
                  : "Derived from the checklist and the judge's findings independently — they agree."}
              </p>
            </div>
          )}
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard
            label="Task success"
            value={formatPercent(summary.score)}
            hint="Weighted share of the success checklist that passed."
            icon={<IconLayers size={15} />}
            actionLabel="See the checklist"
            onClick={() => onOpen("checklist")}
          />
          <StatCard
            label="Failure modes"
            value={summary.judged ? summary.failures.length : "—"}
            unit={summary.judged ? undefined : "not judged"}
            hint={
              summary.judged
                ? criticalCount > 0
                  ? `${criticalCount} critical. Open one to jump to the moment.`
                  : "Open one to jump to the moment it happened."
                : "No judge has read this run yet."
            }
            icon={<IconAlert size={15} />}
            actionLabel="See the findings"
            onClick={() => onOpen("failures")}
          />
          <StatCard
            label="Cost"
            value={formatUsd(costUsd)}
            hint="Every model call in the run — agent, director and judge."
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
