"use client";

import { useRouter } from "next/navigation";
import {
  Badge,
  Chip,
  EmptyState,
  IconClock,
  SERVICE_LABELS,
  Table,
  type BadgeStatus,
  type Column,
} from "@sonata/ui";
import type { RunStatus } from "@sonata/core";
import { ago, elapsed, percent } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import type { RunSummary } from "../../api/_lib/types";

// History. Every row is a door: a finished run opens its results, a live one
// opens the day it is still playing.

const BADGE: Record<RunStatus, BadgeStatus> = {
  queued: "pending",
  running: "running",
  judging: "running",
  done: "passed",
  failed: "failed",
  aborted: "neutral",
};

const LABEL: Record<RunStatus, string> = {
  queued: "Starting",
  running: "Running",
  judging: "Judging",
  done: "Finished",
  failed: "Errored",
  aborted: "Stopped",
};

const LIVE: readonly RunStatus[] = ["queued", "running", "judging"];

export function runHref(run: RunSummary): string {
  return LIVE.includes(run.status) ? `/runs/${run.runId}` : `/results/${run.runId}`;
}

export type PastRunsProps = {
  runs: readonly RunSummary[];
  /** Server time from the last poll, so "4 min ago" never drifts. */
  now: number;
};

export function PastRuns({ runs, now }: PastRunsProps) {
  const router = useRouter();

  const columns: readonly Column<RunSummary>[] = [
    {
      key: "scenario",
      header: "Scenario",
      render: (run) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-sn-ink">{run.specTitle}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {run.twins.map((twin) => (
              <Chip key={twin} service={twin} size="sm">
                {SERVICE_LABELS[twin]}
              </Chip>
            ))}
          </div>
        </div>
      ),
    },
    { key: "model", header: "Model", render: (run) => modelLabel(run.model), width: "170px" },
    {
      key: "when",
      header: "When",
      render: (run) => <span className="text-sn-muted">{ago(run.startedAt, now)}</span>,
      width: "120px",
    },
    {
      key: "duration",
      header: "Took",
      align: "right",
      width: "90px",
      render: (run) => (
        <span data-numeric className="text-sn-muted">
          {elapsed(run.startedAt, run.endedAt ?? now)}
        </span>
      ),
    },
    {
      key: "score",
      header: "Score",
      align: "right",
      width: "90px",
      render: (run) => (
        <span data-numeric className={run.score === null ? "text-sn-subtle" : "text-sn-ink"}>
          {percent(run.score)}
        </span>
      ),
    },
    {
      key: "autonomy",
      header: "Autonomy",
      align: "right",
      width: "100px",
      render: (run) => (
        <span data-numeric className={run.autonomy === null ? "text-sn-subtle" : "text-sn-ink"}>
          {percent(run.autonomy)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      width: "120px",
      render: (run) => (
        <Badge status={BADGE[run.status]} size="sm" dot={run.status === "running"}>
          {LABEL[run.status]}
        </Badge>
      ),
    },
  ];

  return (
    <Table
      columns={columns}
      rows={runs}
      rowKey={(run) => run.runId}
      rowLabel={(run) => `${run.specTitle} on ${modelLabel(run.model)}`}
      onRowClick={(run) => router.push(runHref(run))}
      caption="Past runs, newest first"
      empty={
        <EmptyState
          size="sm"
          icon={<IconClock size={18} />}
          title="No runs yet"
          description="Every day you play lands here with its score, how long it took and what it cost. Start one above and this fills in while it runs."
          hints={[
            "A run is one simulated workday, replayable step by step afterwards",
            "Run the same scenario on two models to get the benchmark table",
          ]}
        />
      }
    />
  );
}
