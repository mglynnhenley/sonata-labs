"use client";

import { Badge, buttonClasses, Card, Chip, IconArrowRight, IconClock, ProgressBar } from "@sonata/ui";
import { ago, elapsed, simClock } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { ROUTES } from "@/lib/routes";
import type { RunSummary } from "@/lib/db";
import { useGo } from "./useGo";

// The live run, on Home. The clock is the hero because the simulated day is the
// thing being watched — the wall-clock elapsed time is the small print.

export interface RunningCardProps {
  run: RunSummary;
  /** Server time from the last poll, so "started 3 min ago" never drifts. */
  now: number;
}

export function RunningCard({ run, now }: RunningCardProps) {
  const go = useGo();
  const href = ROUTES.run(run.id);
  const judging = run.status === "judging";
  const queued = run.status === "queued";

  return (
    <Card padding="lg" className="animate-sn-rise">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge status="running">
              {queued ? "Starting" : judging ? "Judging" : "Running"}
            </Badge>
            <Chip>{modelLabel(run.model)}</Chip>
            {run.worldName ? <Chip>{run.worldName}</Chip> : null}
          </div>
          <h2 className="mt-3 font-display text-[30px] text-sn-ink">
            <a href={href} onClick={(e) => go(e, href)} className="rounded-sn-sm">
              {run.episodeTitle}
            </a>
          </h2>
          <p className="mt-1 text-[13px] text-sn-subtle">
            Started {ago(run.startedAt, now)} · {elapsed(run.startedAt, now)} of real time
          </p>
        </div>

        <a href={href} onClick={(e) => go(e, href)} className={buttonClasses("primary", "lg")}>
          Watch the day
          <IconArrowRight size={15} />
        </a>
      </div>

      <div className="mt-7 flex flex-wrap items-end gap-8">
        <div>
          <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
            Simulated time
          </p>
          <p
            data-numeric
            className="font-display-upright mt-1 text-[46px] leading-none text-sn-ink"
          >
            {simClock(run.simTime)}
          </p>
        </div>

        <div className="min-w-[240px] flex-1">
          <ProgressBar
            value={run.tick}
            max={run.totalTicks}
            tone={judging ? "gold" : "primary"}
            label={judging ? "Reading the day back" : "The day so far"}
            showValue
            valueLabel={`Tick ${run.tick} of ${run.totalTicks}`}
            indeterminate={queued || judging}
          />
        </div>
      </div>

      <div className="mt-6 flex items-start gap-2.5 rounded-sn-lg bg-sn-bg-subtle px-4 py-3">
        <IconClock size={14} className="mt-0.5 shrink-0 text-sn-subtle" />
        <p className="text-[13px] leading-[20px] text-sn-muted">
          {run.lastEvent ?? "Waiting for the first thing to happen."}
        </p>
      </div>
    </Card>
  );
}
