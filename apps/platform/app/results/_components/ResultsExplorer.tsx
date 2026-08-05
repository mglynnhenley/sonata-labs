"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  IconLayers,
  IconPlay,
  PageHeader,
  ProgressBar,
  Table,
  Tabs,
  cn,
  type Column,
} from "@sonata/ui";
import {
  badgeStatus,
  buildBenchmark,
  CHECKLIST_HINT,
  CHECKLIST_LABEL,
  formatDuration,
  formatPercent,
  formatUsd,
  formatWhen,
  outcomeLabel,
  type RunSummary,
} from "../_lib/summary";
import { modelLabel } from "@/lib/models";
import { BenchmarkTable } from "./BenchmarkTable";
import { FailureChipList } from "./FailureChips";

// The results index and the benchmark are the same data seen two ways, so they
// live in one component and share one filter: switching to the table must not
// mean re-choosing which models you care about.

type View = "runs" | "benchmark";

function distinct<T, K extends string>(rows: T[], key: (row: T) => K, label: (row: T) => string) {
  const seen = new Map<K, string>();
  for (const row of rows) if (!seen.has(key(row))) seen.set(key(row), label(row));
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

export function ResultsExplorer({
  runs,
  initialSpec,
  initialModel,
  initialView,
}: {
  runs: RunSummary[];
  initialSpec: string;
  initialModel: string;
  initialView: View;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialView);
  const [spec, setSpec] = useState(initialSpec);
  const [model, setModel] = useState(initialModel);

  const scenarios = useMemo(
    () => distinct(runs, (r) => r.specId, (r) => r.specTitle),
    [runs],
  );
  const models = useMemo(
    () => distinct(runs, (r) => r.model, (r) => modelLabel(r.model)),
    [runs],
  );

  const filtered = useMemo(
    () =>
      runs.filter(
        (run) => (spec === "all" || run.specId === spec) && (model === "all" || run.model === model),
      ),
    [runs, spec, model],
  );

  const benchmark = useMemo(() => buildBenchmark(filtered), [filtered]);
  const filtersOn = spec !== "all" || model !== "all";

  const columns: Column<RunSummary>[] = [
    {
      key: "scenario",
      header: "Scenario",
      width: "26%",
      render: (run) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-sn-ink" title={run.specTitle}>
            {run.specTitle}
          </div>
          <div className="mt-0.5 text-[12px] text-sn-subtle">{formatWhen(run.startedAt)}</div>
        </div>
      ),
    },
    {
      key: "model",
      header: "Model",
      width: "15%",
      // The label, not the slug: at this column width "anthropic/claude-…"
      // truncates away the only part that differs between two rows.
      render: (run) => (
        <span className="block truncate text-[12.5px] text-sn-muted" title={run.model}>
          {modelLabel(run.model)}
        </span>
      ),
    },
    {
      key: "autonomy",
      header: "Autonomy",
      width: "12%",
      // An empty bar at 0% reads as "scored zero". A run with no result gets the
      // words instead, so the row cannot be misread at a glance.
      render: (run) =>
        run.noResult ? (
          <span className="text-[12.5px] text-sn-subtle" title={run.noResult}>
            Never ran — no result
          </span>
        ) : (
          <div className="w-full">
            <div data-numeric className="text-[15px] font-medium text-sn-ink">
              {formatPercent(run.autonomy)}
            </div>
            <ProgressBar
              className="mt-1"
              size="sm"
              value={(run.autonomy ?? 0) * 100}
              tone={
                (run.autonomy ?? 0) >= 0.75
                  ? "success"
                  : (run.autonomy ?? 0) >= 0.4
                    ? "gold"
                    : "danger"
              }
            />
          </div>
        ),
    },
    {
      key: "outcome",
      // Named for the number it holds. "Task success" also labelled Home's pass
      // rate — a share of runs, not of criteria — and one word over two
      // denominators is how the two pages came to contradict each other.
      header: CHECKLIST_LABEL,
      width: "14%",
      render: (run) => (
        <div className="flex items-center gap-2">
          <Badge status={badgeStatus(run)} size="sm">
            {outcomeLabel(run)}
          </Badge>
          <span data-numeric className="text-[12px] text-sn-muted" title={CHECKLIST_HINT}>
            {formatPercent(run.score)}
          </span>
        </div>
      ),
    },
    {
      key: "failures",
      header: "Failure modes",
      width: "17%",
      render: (run) =>
        run.judged ? (
          <FailureChipList
            failures={run.failures}
            max={1}
            href={`/results/${run.runId}#failures`}
          />
        ) : (
          <span className="text-[12px] text-sn-subtle">not judged yet</span>
        ),
    },
    {
      key: "cost",
      header: "Cost",
      width: "8%",
      align: "right",
      render: (run) => (
        <span data-numeric className="text-[12px] whitespace-nowrap text-sn-muted">
          {formatUsd(run.costUsd)}
        </span>
      ),
    },
    {
      key: "duration",
      header: "Took",
      width: "8%",
      align: "right",
      render: (run) => (
        <span data-numeric className="text-[12px] whitespace-nowrap text-sn-muted">
          {formatDuration(run.durationMs)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Results"
        title="What the agents actually did"
        subtitle="Every run that finished, the score it earned, and how it failed. Open one to walk the day step by step."
        actions={
          runs.length > 0 ? (
            <Button variant="secondary" icon={<IconPlay size={14} />} onClick={() => router.push("/runs")}>
              Start another run
            </Button>
          ) : null
        }
      />

      {runs.length === 0 ? (
        <EmptyState
          icon={<IconLayers size={20} />}
          title="No runs have finished yet"
          description="A run leaves an artifact behind: the day it played, the score it earned and the judge's reading of it. This page is where you compare them."
          hints={[
            "One row per run — autonomy, checklist score, cost and how long the day took",
            "Open a run to replay it tick by tick and see every tool call",
            "Run the same scenario on two models to fill the benchmark table",
          ]}
          action={
            <Button variant="primary" icon={<IconPlay size={14} />} onClick={() => router.push("/runs")}>
              Start the day
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Tabs
              variant="pill"
              idPrefix="results"
              label="Results views"
              value={view}
              onValueChange={(id) => setView(id === "benchmark" ? "benchmark" : "runs")}
              items={[
                { id: "runs", label: "Runs", count: filtered.length },
                { id: "benchmark", label: "Benchmark", count: benchmark.rows.length },
              ]}
            />
            {filtersOn ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSpec("all");
                  setModel("all");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-2.5">
            <FilterRow
              label="Scenario"
              options={scenarios}
              value={spec}
              onChange={setSpec}
              allLabel="All scenarios"
            />
            <FilterRow
              label="Model"
              options={models}
              value={model}
              onChange={setModel}
              allLabel="All models"
            />
          </div>

          {view === "runs" ? (
            filtered.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nothing matches those filters"
                description="No run has been recorded for that scenario and model pairing yet."
                action={
                  <Button
                    onClick={() => {
                      setSpec("all");
                      setModel("all");
                    }}
                  >
                    Show every run
                  </Button>
                }
              />
            ) : (
              <Table
                columns={columns}
                rows={filtered}
                rowKey={(run) => run.runId}
                rowLabel={(run) =>
                  `${run.specTitle} on ${modelLabel(run.model)}, ${outcomeLabel(run)}`
                }
                onRowClick={(run) => router.push(`/results/${run.runId}`)}
                caption="Finished runs"
                // Auto layout treats the column widths as suggestions and lets a
                // long scenario title shove the cost off the card. Fixed layout
                // makes them binding, which is also what makes `truncate` work
                // inside a cell at all.
                className="[&>table]:table-fixed"
              />
            )
          ) : (
            <BenchmarkTable benchmark={benchmark} />
          )}

          <p className="text-[12px] text-sn-subtle">
            {filtered.length} of {runs.length} run{runs.length === 1 ? "" : "s"}.{" "}
            <Link href="/runs" className="text-sn-primary-ink underline underline-offset-2">
              Start another
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

function FilterRow({
  label,
  options,
  value,
  onChange,
  allLabel,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  value: string;
  onChange: (id: string) => void;
  allLabel: string;
}) {
  // One chip per option, always all of them: a scenario with no runs on the
  // selected model is information, and hiding it would hide the gap.
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[62px] shrink-0 text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {label}
      </span>
      <Chip
        size="sm"
        icon={false}
        selected={value === "all"}
        onClick={() => onChange("all")}
        className={cn(value === "all" && "border-sn-primary-soft bg-sn-primary-soft text-sn-primary-ink")}
      >
        {allLabel}
      </Chip>
      {options.map((option) => (
        <Chip
          key={option.id}
          size="sm"
          icon={false}
          selected={value === option.id}
          onClick={() => onChange(value === option.id ? "all" : option.id)}
          className={cn(
            value === option.id && "border-sn-primary-soft bg-sn-primary-soft text-sn-primary-ink",
          )}
        >
          {option.name}
        </Chip>
      ))}
    </div>
  );
}
