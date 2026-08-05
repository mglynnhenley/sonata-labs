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
import { NO_RESULT, type RunStatus } from "@sonata/core";
import { ago, elapsed, percent } from "@/lib/format";
import { modelLabel } from "@/lib/models";
// One name for the checklist number, wherever it is printed.
import { CHECKLIST_HINT, CHECKLIST_LABEL } from "../../results/_lib/summary";
import type { RunSummary } from "../../api/_lib/types";

// History. Every row is a door: a finished run opens its results, a live one
// opens the day it is still playing.

// This column answers "did the day play?", NOT "did the agent do the job" — the
// summary this list is built from carries no outcome, only a run status. It used
// to render `done` as a green "Finished", which put the same run under a green
// tick here and a red "Failed" on its results page. Green is the outcome's to
// give, so the neutral tone and the plainer word stay out of its way; the score
// and autonomy columns beside this one are where the judgement lives.
const BADGE: Record<RunStatus, BadgeStatus> = {
  queued: "pending",
  running: "running",
  judging: "running",
  done: "neutral",
  failed: "failed",
  aborted: "neutral",
};

const LABEL: Record<RunStatus, string> = {
  queued: "Starting",
  running: "Running",
  judging: "Judging",
  done: "Ran to the end",
  failed: "Errored",
  aborted: "Stopped",
};

const LIVE: readonly RunStatus[] = ["queued", "running", "judging"];

/**
 * What the status cell says. A finished run with no score is not "Finished" —
 * the agent never ran, and the row has to say so rather than leave two dashes
 * for the reader to interpret.
 */
function statusOf(run: RunSummary): { tone: BadgeStatus; label: string } {
  if (!LIVE.includes(run.status) && run.score === null) {
    return { tone: run.status === "failed" ? "failed" : "neutral", label: NO_RESULT };
  }
  return { tone: BADGE[run.status], label: LABEL[run.status] };
}

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
      // The same number the results page calls "checklist score". Headed "Score"
      // here, it read as the headline; the headline is autonomy, in the column
      // beside it.
      header: CHECKLIST_LABEL,
      align: "right",
      width: "110px",
      render: (run) => (
        <span
          data-numeric
          className={run.score === null ? "text-sn-subtle" : "text-sn-ink"}
          title={CHECKLIST_HINT}
        >
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
      // "The day", not "Status": this says whether the day played, and the
      // results page's badge says whether the agent passed. Two questions, two
      // headings — one run reading "Finished" here and "Failed" there was one
      // heading doing both jobs.
      header: "The day",
      align: "right",
      width: "140px",
      render: (run) => {
        const status = statusOf(run);
        return (
          <Badge status={status.tone} size="sm" dot={run.status === "running"}>
            {status.label}
          </Badge>
        );
      },
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
