"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  buttonClasses,
  Card,
  Chip,
  IconArrowRight,
  PageHeader,
  ProgressBar,
  useToast,
} from "@sonata/ui";
import { elapsed, simClock } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { ROUTES } from "@/lib/routes";
import { StaleNotice } from "../../_components/StaleNotice";
import { usePoll } from "../../_components/usePoll";
import { useSimulated } from "../../_components/useSimulated";
import { useGo } from "../../_components/useGo";
import { apiSend } from "../../api/_lib/client";
import { track } from "@/lib/track";
import type { EpisodeSummary, RunSummary, StartRunInput } from "../../api/_lib/types";
import { PastRuns } from "./PastRuns";
import { StartRunPanel } from "./StartRunPanel";

// The Runs page: start a day, watch the one that is playing, browse the ones
// that already played. The live view itself lives at /runs/[runId] — this page
// only ever shows the door to it, so the hero is never half-rendered in a list.

export interface RunsFeed {
  runs: RunSummary[];
  activeRunId: string | null;
  /** Server clock, so relative times survive hydration. */
  at: number;
}

export type RunsClientProps = {
  initial: RunsFeed;
  episodes: EpisodeSummary[];
  defaultModel: string;
  /** Beat ticks per scenario — see the run panel's own prop doc. */
  beatTicks: Record<string, number[]>;
  /** From `?scenario=` — the card that sent you here. */
  initialEpisodeId?: string;
  /** Whether an OpenRouter key is saved — without one nothing can run. */
  hasKey: boolean;
};

export function RunsClient({
  initial,
  episodes,
  defaultModel,
  beatTicks,
  initialEpisodeId,
  hasKey,
}: RunsClientProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();
  const poll = usePoll<RunsFeed>("/api/runs", 3000, initial);
  const { data, refresh } = poll;
  // Which of these rows no model ever played. /api/runs answers off the document
  // store, which has no way to know — the question is only decidable from the
  // artifacts, so it is asked once, where Home asks it.
  const simulated = useSimulated();

  const [starting, setStarting] = useState(false);

  const active = data.runs.find((run) => run.runId === data.activeRunId) ?? null;

  async function start(input: StartRunInput) {
    setStarting(true);
    try {
      const { runId } = await apiSend<{ runId: string }>("/api/runs", "POST", input);
      track("run_started", { episode_id: input.episodeId, model: input.model, twins: input.twins, ticks: input.ticks });
      // Deliberately left true: the button keeps spinning until the live view
      // has actually replaced this page.
      router.push(`/runs/${runId}`);
    } catch (err) {
      setStarting(false);
      toast({
        title: "The day did not start",
        description: (err as Error).message,
        tone: "error",
      });
    }
  }


  return (
    <div className="sn-stack-section">
      <PageHeader
        title="Runs"
        subtitle="Run models on a reviewed scenario. Compare completed work, mistakes and cost under the same conditions."
        actions={
          active ? (
            // A real anchor, so the live run can be opened in its own tab.
            <a
              href={`/runs/${active.runId}`}
              onClick={(e) => go(e, `/runs/${active.runId}`)}
              className={buttonClasses("primary", "md")}
            >
              Watch the day
              <IconArrowRight size="sm" />
            </a>
          ) : undefined
        }
      />

      <StaleNotice poll={poll} what="the run list" />

      {active ? <LiveRunBanner run={active} now={data.at} href={`/runs/${active.runId}`} /> : null}

      <StartRunPanel
        episodes={episodes}
        defaultModel={defaultModel}
        beatTicks={beatTicks}
        initialEpisodeId={initialEpisodeId}
        starting={starting}
        hasKey={hasKey}
        onStart={(input) => void start(input)}
      />

      {/* The count and the outbound link are the card's own actions now. NOT
          "on this machine": this list is `/api/runs`, the dashboard's document
          store, while CLI runs land only in the artifact directory. Saying "on
          this machine" over one of two stores is how this page claimed 1 run
          while the results page counted 11 of the same days — so the link goes
          to the benchmark, which reads the full record. */}
      <PastRuns
        runs={data.runs}
        now={data.at}
        simulated={simulated}
        actions={
          <div className="flex items-center gap-3 text-sn-sm text-sn-subtle">
            <button
              type="button"
              onClick={refresh}
              className="transition-colors duration-150 ease-sn hover:text-sn-ink"
            >
              {data.runs.length} run{data.runs.length === 1 ? "" : "s"} started from this dashboard
            </button>
            <a
              href={ROUTES.compare}
              onClick={(e) => go(e, ROUTES.compare)}
              className="text-sn-primary-ink underline underline-offset-2"
            >
              Every scored run, compared
            </a>
          </div>
        }
      />
    </div>
  );
}

function LiveRunBanner({
  run,
  now,
  href,
}: {
  run: RunSummary;
  now: number;
  /** The live run's own page. Passed as a URL, not a handler, so the banner's
   *  way in is a real link. */
  href: string;
}) {
  const go = useGo();
  return (
    <Card padding="lg" className="animate-sn-rise">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge status="running" dot>
              {run.paused ? "Paused" : run.status === "judging" ? "Judging" : "Running now"}
            </Badge>
            <Chip>{modelLabel(run.model)}</Chip>
          </div>
          <h2 className="mt-3 font-display text-sn-3xl text-sn-ink">{run.specTitle}</h2>
          <p className="mt-1 text-sn-base text-sn-subtle">
            {elapsed(run.startedAt, run.endedAt ?? now)} of real time so far
          </p>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Simulated time
            </p>
            <p data-numeric className="font-display-upright mt-1 text-sn-4xl leading-none text-sn-ink">
              {simClock(run.simTimeISO)}
            </p>
          </div>
          <a href={href} onClick={(e) => go(e, href)} className={buttonClasses("primary", "lg")}>
            Watch the day
            <IconArrowRight size="md" />
          </a>
        </div>
      </div>

      <div className="mt-6">
        <ProgressBar
          value={run.tickCount}
          max={run.plannedTicks}
          label="The day so far"
          showValue
          valueLabel={`Tick ${run.tickCount} of ${run.plannedTicks}`}
          indeterminate={run.status === "queued" || run.status === "judging"}
        />
      </div>
    </Card>
  );
}
