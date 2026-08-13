"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Card,
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
import { SIMULATED_LABEL } from "../../results/_lib/simulated";
import type { RunSummary } from "../../api/_lib/types";

// History. Every row is a door onto its run — live or finished, the same URL.

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
function statusOf(run: RunSummary, simulated: boolean): { tone: BadgeStatus; label: string } {
  // Before every other reading of the row, and before the score is consulted at
  // all: this list is built from the document store, which still holds the
  // bookkeeping the stand-in wrote for itself. Those docs are settled, so
  // `refresh` serves them verbatim and their score never became null the way the
  // relational rows behind Home did. Read as a normal row, a fabricated day
  // prints "Ran to the end" at 100%.
  if (simulated) return { tone: "neutral", label: SIMULATED_LABEL };
  if (!LIVE.includes(run.status) && run.score === null) {
    return { tone: run.status === "failed" ? "failed" : "neutral", label: NO_RESULT };
  }
  return { tone: BADGE[run.status], label: LABEL[run.status] };
}

export type PastRunsProps = {
  runs: readonly RunSummary[];
  /** Right-hand side of the card's own heading row. */
  actions?: ReactNode;
  /** Server time from the last poll, so "4 min ago" never drifts. */
  now: number;
  /** Run ids the stand-in fabricated. Empty until /api/results/simulated answers. */
  simulated: ReadonlySet<string>;
};

export function PastRuns({ runs, now, simulated, actions }: PastRunsProps) {
  const router = useRouter();

  // A fabricated run's numbers are not small or stale, they are invented — the
  // score came off a seeded coin flip, not off a day. Nothing may print them, so
  // they are dropped here rather than dimmed, and the row says why in its badge.
  const scoreOf = (run: RunSummary): number | null =>
    simulated.has(run.runId) ? null : run.score;
  const autonomyOf = (run: RunSummary): number | null =>
    simulated.has(run.runId) ? null : run.autonomy;

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
    {
      key: "model",
      header: "Model",
      width: "170px",
      // Struck through, not removed, on a fabricated row: the model name was a
      // hash seed there, never a callee, and the row should still say which model
      // it claimed. Same treatment as Home's list.
      render: (run) =>
        simulated.has(run.runId) ? (
          <span className="text-sn-subtle">
            <span className="line-through">{modelLabel(run.model)}</span> · never called
          </span>
        ) : (
          modelLabel(run.model)
        ),
    },
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
      render: (run) => {
        const score = scoreOf(run);
        return (
          <span
            data-numeric
            className={score === null ? "text-sn-subtle" : "text-sn-ink"}
            title={CHECKLIST_HINT}
          >
            {percent(score)}
          </span>
        );
      },
    },
    {
      key: "autonomy",
      header: "Autonomy",
      align: "right",
      width: "100px",
      render: (run) => {
        const autonomy = autonomyOf(run);
        return (
          <span data-numeric className={autonomy === null ? "text-sn-subtle" : "text-sn-ink"}>
            {percent(autonomy)}
          </span>
        );
      },
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
        const status = statusOf(run, simulated.has(run.runId));
        return (
          <Badge status={status.tone} size="sm" dot={run.status === "running"}>
            {status.label}
          </Badge>
        );
      },
    },
  ];

  return (
    // The card names itself: the page is a stack of titled panels, not a
    // column of headings with tables hanging beneath them.
    <Card
      padding="none"
      title="Past runs"
      subtitle="Every day played from this dashboard, newest first"
      actions={actions}
    >
    <Table
      columns={columns}
      rows={runs}
      rowKey={(run) => run.runId}
      rowLabel={(run) => `${run.specTitle} on ${modelLabel(run.model)}`}
      // One run, one URL: /runs/{id} serves the day live and its verdict after,
      // so a row needs no guess about which page its run belongs on.
      // Both, deliberately: the click routes on the client, the href is what
      // makes Cmd-click and middle-click open the run in a tab. This list is the
      // only way into a run, so it has to behave like the links it is.
      rowHref={(run) => `/runs/${run.runId}`}
      onRowClick={(run) => router.push(`/runs/${run.runId}`)}
      caption="Past runs, newest first"
      empty={
        <EmptyState
          size="sm"
          icon={<IconClock size="lg" />}
          title="No runs yet"
          description="Every day you play lands here with its score, how long it took and what it cost. Start one above and this fills in while it runs."
          hints={[
            "A run is one simulated workday, replayable step by step afterwards",
            "Run the same scenario on two models to get the benchmark table",
          ]}
        />
      }
    />
    </Card>
  );
}
