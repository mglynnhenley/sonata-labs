"use client";

import { Card, Chip, ProgressBar, SERVICE_LABELS } from "@sonata/ui";
import type { Overview } from "@/lib/overview";

// The dashboard's right rail: how the benchmark itself is doing, and what is
// currently standing. Three bars and a chip row — every number here comes off
// the same overview payload the stat row reads, because a rail that quietly
// invents a metric is worse than a shorter rail.

export type QueueHealthProps = {
  stats: Overview["stats"];
  twins: Overview["twins"];
  /** Total scenarios saved — the denominator for coverage. */
  scenarios: number;
};

export function QueueHealth({ stats, twins, scenarios }: QueueHealthProps) {
  const up = twins.filter((twin) => twin.ok).length;

  return (
    <Card
      title="Queue health"
      subtitle={twins.length > 0 ? `${up} of ${twins.length} apps answering` : "Checking the three apps…"}
    >
      <div className="flex flex-col gap-5 pt-1">
        {/* How much of the scenario library has ever been scored. A benchmark
            that only ever runs two of its twenty days is not a benchmark. */}
        <ProgressBar
          label="Scenario coverage"
          value={stats.scenariosCovered}
          max={Math.max(scenarios, 1)}
          tone="gold"
          showValue
          valueLabel={scenarios === 0 ? "none saved" : `${stats.scenariosCovered} of ${scenarios}`}
        />
        <ProgressBar
          label="Runs passed"
          value={stats.passRate === null ? 0 : Math.round(stats.passRate * 100)}
          tone="success"
          showValue
          valueLabel={
            stats.passRate === null
              ? "—"
              : `${Math.round(stats.passRate * stats.scored)} of ${stats.scored}`
          }
        />
        <ProgressBar
          label="Mean autonomy"
          value={stats.autonomy === null ? 0 : Math.round(stats.autonomy * 100)}
          tone="primary"
          showValue
          valueLabel={stats.autonomy === null ? "—" : `${Math.round(stats.autonomy * 100)}%`}
        />

        <div className="flex flex-col gap-2.5 border-t border-sn-line pt-4">
          <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
            Systems cloned
          </p>
          <div className="flex flex-wrap gap-2">
            {twins.map((twin) => (
              // Down apps read as absent rather than fine: the chip dims and
              // says so, because "Slack" beside two live apps looks identical
              // to a working one at a glance.
              <Chip
                key={twin.twin}
                service={twin.twin}
                size="sm"
                className={twin.ok ? undefined : "opacity-45"}
                title={`${twin.label} · ${twin.detail}`}
              >
                {twin.ok ? SERVICE_LABELS[twin.twin] : `${SERVICE_LABELS[twin.twin]} · down`}
              </Chip>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
