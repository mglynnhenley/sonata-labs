"use client";

import { Badge, Button, Card, EmptyState, IconArrowRight, IconPlay, type BadgeStatus } from "@sonata/ui";
import { ago, percent } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { ROUTES } from "@/lib/routes";
import type { RunSummary } from "@/lib/db";
import { useGo } from "./useGo";

// Recent runs. Every row is a door onto its replay, and the autonomy figure sits
// on the row rather than behind a click — it is the number the whole product is
// about, and it should be readable at a glance from Home.

function statusOf(run: RunSummary): { tone: BadgeStatus; label: string } {
  if (run.status === "done") {
    if (run.outcome === "pass") return { tone: "passed", label: "Passed" };
    if (run.outcome === "fail") return { tone: "failed", label: "Failed" };
    return { tone: "warning", label: "Partial" };
  }
  if (run.status === "failed") return { tone: "failed", label: "Errored" };
  if (run.status === "aborted") return { tone: "neutral", label: "Stopped" };
  if (run.status === "judging") return { tone: "running", label: "Judging" };
  if (run.status === "queued") return { tone: "running", label: "Starting" };
  return { tone: "running", label: "Running" };
}

export interface RecentRunsProps {
  runs: RunSummary[];
  now: number;
}

export function RecentRuns({ runs, now }: RecentRunsProps) {
  const go = useGo();

  return (
    <Card padding="none">
      <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-3">
        <h2 className="text-[14px] font-medium text-sn-ink">Recent runs</h2>
        <a
          href={ROUTES.runs}
          onClick={(e) => go(e, ROUTES.runs)}
          className="group inline-flex items-center gap-1.5 rounded-sn-sm text-[13px] font-medium text-sn-primary-ink"
        >
          All runs
          <IconArrowRight
            size={13}
            className="transition-transform duration-150 ease-sn group-hover:translate-x-0.5"
          />
        </a>
      </div>

      {runs.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState
            size="sm"
            icon={<IconPlay size={16} />}
            title="No runs yet"
            description="A run plays one simulated workday against a scenario, with your agent inside it. Finished runs land here with their score."
            hints={[
              "The score is how much of the checklist the agent completed",
              "Autonomy is how much it did without handing the job back",
              "Every run keeps a step-by-step replay you can walk with the arrow keys",
            ]}
            action={
              <Button variant="primary" onClick={(e) => go(e, ROUTES.runs)}>
                Start the day
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="border-t border-sn-line">
          {runs.map((run) => {
            const status = statusOf(run);
            const href = ROUTES.run(run.id);
            return (
              <li key={run.id} className="border-b border-sn-line last:border-b-0">
                <a
                  href={href}
                  onClick={(e) => go(e, href)}
                  className="group flex items-center gap-4 px-5 py-3.5 transition-colors duration-150 ease-sn hover:bg-sn-surface-hover"
                >
                  <Badge status={status.tone} size="sm" className="w-[86px] justify-center">
                    {status.label}
                  </Badge>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-sn-ink">
                      {run.episodeTitle}
                    </span>
                    <span className="block truncate text-[12px] text-sn-subtle">
                      {modelLabel(run.model)}
                      {run.worldName ? ` · ${run.worldName}` : ""}
                    </span>
                  </span>

                  <span className="hidden w-[92px] shrink-0 text-right sm:block">
                    <span data-numeric className="block text-[15px] font-medium text-sn-ink">
                      {percent(run.autonomy)}
                    </span>
                    <span className="block text-[11px] tracking-[0.04em] text-sn-subtle uppercase">
                      Autonomy
                    </span>
                  </span>

                  <span className="w-[76px] shrink-0 text-right text-[12px] text-sn-subtle">
                    {ago(run.endedAt ?? run.startedAt, now)}
                  </span>

                  <IconArrowRight
                    size={14}
                    className="shrink-0 text-sn-subtle transition-transform duration-150 ease-sn group-hover:translate-x-0.5 group-hover:text-sn-ink"
                  />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
