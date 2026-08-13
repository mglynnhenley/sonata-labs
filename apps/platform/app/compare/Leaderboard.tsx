"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Card,
  Chip,
  EmptyState,
  IconLayers,
  Table,
  type Column,
} from "@sonata/ui";
import { modelLabel } from "@/lib/models";
import {
  CHECKLIST_HINT,
  CHECKLIST_LABEL,
  formatPercent,
  formatUsd,
  type Benchmark,
  type BenchmarkRow,
} from "../results/_lib/summary";

// The leaderboard: models ranked against each other, one row per model. The
// matrix beside it answers "where do models diverge"; this answers "which model
// is best overall", and it is built to be screenshotted into the article — so
// legibility at figure width beats density, and only one number gets emphasis.

/** "All scenarios", or one scenario's slice of the same benchmark. */
const ALL = "all";

type Ranked = {
  model: string;
  runs: number;
  autonomy: number | null;
  checklist: number | null;
  topFailure: BenchmarkRow["topFailure"];
  costPerEpisode: number | null;
  /** The newest run behind the numbers — every row is a door. */
  latestRunId: string | null;
};

/**
 * One model's numbers within the active slice. For a single scenario the cell
 * is the truth; for "all" the row's own means are — they were computed over
 * every scored run, not re-derived here.
 */
function rank(benchmark: Benchmark, slice: string): Ranked[] {
  const rows = benchmark.rows
    .map((row): Ranked | null => {
      if (slice === ALL) {
        const newest = Object.values(row.cells)
          .map((cell) => cell.latestRunId)
          .find((id) => id !== null);
        return {
          model: row.model,
          runs: row.runs,
          autonomy: row.meanAutonomy,
          checklist: row.meanScore,
          topFailure: row.topFailure,
          costPerEpisode: row.costPerEpisode,
          latestRunId: newest ?? null,
        };
      }
      const cell = row.cells[slice];
      if (!cell) return null;
      return {
        model: row.model,
        runs: cell.runs,
        autonomy: cell.autonomy,
        checklist: cell.score,
        // The per-scenario failure split does not exist in the pivot; showing
        // the all-scenario mode against one scenario would misattribute it.
        topFailure: null,
        costPerEpisode: cell.costUsd,
        latestRunId: cell.latestRunId,
      };
    })
    .filter((row): row is Ranked => row !== null);

  return rows.sort((a, b) => (b.autonomy ?? -1) - (a.autonomy ?? -1));
}

/**
 * The figure: one horizontal bar per model, autonomy on a 0–100 axis. The axis
 * deliberately runs to 100 rather than to the leading value — scaled to the
 * leader, 74% and 71% read as a tie, and this chart's job is to show distance.
 * Six divs, no charting library: that is the right amount of machinery.
 */
function AutonomyChart({ rows, sliceTitle }: { rows: Ranked[]; sliceTitle: string }) {
  const drawn = rows.filter((row) => row.autonomy !== null);
  if (drawn.length === 0) return null;

  return (
    <Card padding="lg" title="Autonomy" subtitle={sliceTitle}>
      <div className="mt-1 flex flex-col" style={{ gap: 13 }}>
        {drawn.map((row, index) => {
          const pct = Math.round((row.autonomy ?? 0) * 100);
          return (
            <div
              key={row.model}
              className="grid items-center"
              style={{ gridTemplateColumns: "150px minmax(0,1fr) 44px", columnGap: 14 }}
            >
              <span
                className={
                  index === 0
                    ? "truncate text-right text-[13px] font-bold text-sn-ink"
                    : "truncate text-right text-[13px] text-sn-muted"
                }
                title={modelLabel(row.model)}
              >
                {modelLabel(row.model)}
              </span>
              <div
                className="h-[18px] overflow-hidden rounded-[4px] bg-sn-bg-subtle"
                role="img"
                aria-label={`${modelLabel(row.model)}: ${pct}% autonomy`}
              >
                <div
                  className={
                    index === 0
                      ? "h-full rounded-[4px] bg-sn-primary"
                      : "h-full rounded-[4px] border-r border-sn-running-line bg-sn-primary-soft"
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span data-numeric className="text-right text-[13px] font-medium">
                {pct}%
              </span>
            </div>
          );
        })}
        <div
          className="grid"
          style={{ gridTemplateColumns: "150px minmax(0,1fr) 44px", columnGap: 14 }}
          aria-hidden="true"
        >
          <span />
          <span className="flex justify-between text-[11px] text-sn-subtle">
            <span>0</span>
            <span>50%</span>
            <span>100%</span>
          </span>
          <span />
        </div>
      </div>
    </Card>
  );
}

export function Leaderboard({ benchmark }: { benchmark: Benchmark }) {
  const router = useRouter();
  const [slice, setSlice] = useState<string>(ALL);

  if (benchmark.rows.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size="lg" />}
        title="The leaderboard needs scored runs"
        description="Run two or more models through the same scenario and they rank here: autonomy per model, checklist score, the failure each repeats, and what a day costs."
        hints={["Ranked by autonomy — the share of the day done without a human", "Every row opens the newest run behind its numbers"]}
      />
    );
  }

  const rows = rank(benchmark, slice);
  const sliceTitle =
    slice === ALL
      ? "Across every scored scenario"
      : (benchmark.scenarios.find((s) => s.specId === slice)?.title ?? "");

  const columns: readonly Column<Ranked>[] = [
    {
      key: "position",
      header: "",
      width: "34px",
      render: (_, index) => (
        <span data-numeric className="text-[12px] text-sn-subtle">
          {index + 1}
        </span>
      ),
    },
    {
      key: "model",
      header: "Model",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-sn-ink">{modelLabel(row.model)}</p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-sn-subtle">
            {row.model} · {row.runs} run{row.runs === 1 ? "" : "s"}
          </p>
        </div>
      ),
    },
    {
      // The ranking column and the only number given emphasis: seven loud
      // metrics in a row is a wall, and the figure has to read at a glance.
      key: "autonomy",
      header: "Autonomy",
      align: "right",
      width: "110px",
      render: (row) => (
        <span data-numeric className="text-[15px] font-bold text-sn-ink">
          {formatPercent(row.autonomy)}
        </span>
      ),
    },
    {
      key: "checklist",
      header: CHECKLIST_LABEL,
      align: "right",
      width: "120px",
      render: (row) => (
        <span data-numeric className="text-sn-muted" title={CHECKLIST_HINT}>
          {formatPercent(row.checklist)}
        </span>
      ),
    },
    {
      key: "failure",
      header: "Most common failure",
      align: "left",
      width: "200px",
      render: (row) =>
        row.topFailure ? (
          <span className="text-[12px] text-sn-muted">
            {row.topFailure.label} <span className="text-sn-subtle">×{row.topFailure.count}</span>
          </span>
        ) : (
          <span className="text-[12px] text-sn-subtle">{slice === ALL ? "none found" : "—"}</span>
        ),
    },
    {
      key: "cost",
      header: "Cost / run",
      align: "right",
      width: "96px",
      render: (row) => (
        <span data-numeric className="text-sn-muted">
          {formatUsd(row.costPerEpisode)}
        </span>
      ),
    },
  ];

  return (
    <div className="sn-stack-block">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Slice the leaderboard by scenario">
        <Chip
          tone="neutral"
          icon={false}
          selected={slice === ALL}
          onClick={() => setSlice(ALL)}
        >
          All scenarios
        </Chip>
        {benchmark.scenarios.map((scenario) => (
          <Chip
            key={scenario.specId}
            tone="neutral"
            icon={false}
            selected={slice === scenario.specId}
            onClick={() => setSlice(scenario.specId)}
          >
            {scenario.title}
          </Chip>
        ))}
      </div>

      <AutonomyChart rows={rows} sliceTitle={sliceTitle} />

      <Card padding="none" radius="2xl">
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => row.model}
          rowLabel={(row) => `${modelLabel(row.model)}, ${formatPercent(row.autonomy)} autonomy`}
          rowHref={(row) => (row.latestRunId ? `/runs/${row.latestRunId}` : "#")}
          onRowClick={(row) => {
            if (row.latestRunId) router.push(`/runs/${row.latestRunId}`);
          }}
          caption={`Model leaderboard — ${sliceTitle}`}
        />
      </Card>

      <p className="max-w-[70ch] text-[12px] leading-[18px] text-sn-subtle">
        Autonomy is the share of the day's work finished without handing it back to a human, averaged
        over the slice's scored runs. {CHECKLIST_HINT} Every row opens the newest run behind its
        numbers.
      </p>
    </div>
  );
}
