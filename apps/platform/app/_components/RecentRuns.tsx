"use client";

import { NO_RESULT } from "@sonata/core";
import { useRouter } from "next/navigation";
import {
  Badge,
  buttonClasses,
  Card,
  EmptyState,
  IconPlay,
  Table,
  type BadgeStatus,
  type Column,
} from "@sonata/ui";
import { ago, percent } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { ROUTES } from "@/lib/routes";
import type { RunSummary } from "@/lib/db";
import { SIMULATED_LABEL } from "../results/_lib/simulated";
import { useGo } from "./useGo";

// Recent runs. Every row is a door onto its replay, and the autonomy figure sits
// on the row rather than behind a click — it is the number the whole product is
// about, and it should be readable at a glance from Home.

function statusOf(run: RunSummary, simulated: boolean): { tone: BadgeStatus; label: string } {
  // Before every other reading of the row. A fabricated day reaches here as a
  // finished run with no outcome, which is indistinguishable from a day the
  // agent slept through — and the two are not the same admission.
  if (simulated) return { tone: "neutral", label: SIMULATED_LABEL };
  if (run.status === "done") {
    if (run.outcome === "pass") return { tone: "passed", label: "Passed" };
    if (run.outcome === "fail") return { tone: "failed", label: "Failed" };
    if (run.outcome === "partial") return { tone: "warning", label: "Partial" };
    // Grey, not amber, and never green: a run whose must-dos nothing could check
    // has not been graded. Amber would put it on the scale between pass and fail,
    // which is the one thing this state is not. This is the row that used to read
    // "Passed" over an agent that drafted four refunds and sent none of them.
    if (run.outcome === "inconclusive") return { tone: "neutral", label: "Inconclusive" };
    // Finished with no outcome: the agent never acted, so there is nothing to
    // call passed, partial or failed. It used to fall through to "Partial".
    return { tone: "neutral", label: NO_RESULT };
  }
  if (run.status === "failed") return { tone: "failed", label: "Errored" };
  if (run.status === "aborted") return { tone: "neutral", label: "Stopped" };
  if (run.status === "judging") return { tone: "running", label: "Judging" };
  if (run.status === "queued") return { tone: "running", label: "Starting" };
  return { tone: "running", label: "Running" };
}

export interface RecentRunsProps {
  /** The clock's minutes per tick, so a tick count reads as simulated time. */
  simMinutesPerTick: number;
  runs: RunSummary[];
  now: number;
  /** Run ids the stand-in fabricated. Empty until /api/results/simulated answers. */
  simulated: ReadonlySet<string>;
}

export function RecentRuns({ runs, now, simulated, simMinutesPerTick }: RecentRunsProps) {
  const go = useGo();
  const router = useRouter();

  const columns: readonly Column<RunSummary>[] = [
    {
      key: "scenario",
      header: "Scenario",
      render: (run) => (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-sn-ink">{run.episodeTitle}</p>
          <p className="mt-0.5 truncate text-[12px] text-sn-subtle">
            {/* The model name is the lie on a fabricated row — it was a hash
                seed, not a callee — so it is struck through rather than removed.
                The row still says which model it claimed. */}
            <span className={simulated.has(run.id) ? "line-through" : undefined}>
              {modelLabel(run.model)}
            </span>
            {simulated.has(run.id) ? " · never called" : ""}
          </p>
        </div>
      ),
    },
    {
      // The clone the day played inside. Real: every run records the company it
      // was seeded from, and it is the second thing you want after the scenario.
      key: "environment",
      header: "Environment",
      width: "170px",
      render: (run) => <span className="truncate text-sn-muted">{run.worldName}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "132px",
      render: (run) => {
        const status = statusOf(run, simulated.has(run.id));
        return (
          <Badge status={status.tone} size="sm" dot={run.status === "running"}>
            {status.label}
          </Badge>
        );
      },
    },
    {
      // How far into the simulated day the run got. Ticks × the clock, which is
      // exactly what the "median horizon" card above averages.
      key: "horizon",
      header: "Horizon",
      align: "right",
      width: "88px",
      render: (run) => (
        <span data-numeric className="text-sn-muted">
          {run.tick > 0 ? `${run.tick * simMinutesPerTick} min` : "—"}
        </span>
      ),
    },
    {
      // The checklist score, which is what this product's judge actually
      // produces — a share, not a mark out of five.
      key: "judge",
      header: "Judge",
      align: "right",
      width: "84px",
      render: (run) => (
        <span
          data-numeric
          className={simulated.has(run.id) || run.score === null ? "text-sn-subtle" : "text-sn-ink"}
        >
          {percent(simulated.has(run.id) ? null : run.score)}
        </span>
      ),
    },
  ];

  return (
    // The card names itself: the page is a grid of titled panels, not a column
    // of headings with cards hanging under them.
    <Card
      padding="none"
      title="Recent runs"
      subtitle="Latest simulations across every environment"
      actions={
        <a href={ROUTES.runs} onClick={(e) => go(e, ROUTES.runs)} className={buttonClasses("ghost", "sm")}>
          View all
        </a>
      }
    >
      <Table
        columns={columns}
        rows={runs}
        rowKey={(run) => run.id}
        rowLabel={(run) => `${run.episodeTitle} on ${modelLabel(run.model)}`}
        rowHref={(run) => ROUTES.run(run.id)}
        onRowClick={(run) => router.push(ROUTES.run(run.id))}
        dense
        caption="The most recent runs, newest first"
        empty={
          <div className="px-5 pb-5">
            <EmptyState
              size="sm"
              icon={<IconPlay size="md" />}
              title="No runs yet"
              description="A run plays one simulated workday against a scenario, with your agent inside it. Finished runs land here with their score."
              hints={[
                "The score is how much of the checklist the agent completed",
                "Autonomy is how much it did without handing the job back",
                "Every run keeps a step-by-step replay you can walk with the arrow keys",
              ]}
              action={
                <a
                  href={ROUTES.runs}
                  onClick={(e) => go(e, ROUTES.runs)}
                  className={buttonClasses("primary", "md")}
                >
                  New run
                </a>
              }
            />
          </div>
        }
      />
    </Card>
  );
}
