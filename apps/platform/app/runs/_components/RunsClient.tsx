"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Chip,
  IconArrowRight,
  PageHeader,
  ProgressBar,
  Spinner,
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
import type { EpisodeRecord, EpisodeSummary, RunSummary, StartRunInput } from "../../api/_lib/types";
import { PastRuns } from "./PastRuns";
import { StartRunPanel } from "./StartRunPanel";

// The Runs page: start a day, watch the one that is playing, browse the ones
// that already played. The live view itself lives at /runs/[runId] — this page
// only ever shows the door to it, so the hero is never half-rendered in a list.

/** The stock day the guided demo uses. Written to be the best first run. */
const DEMO_TEMPLATE = "client-escalation";

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
  /** From `?demo=1` — set the demo up and start it, no questions asked. */
  demo: boolean;
};

export function RunsClient({
  initial,
  episodes,
  defaultModel,
  beatTicks,
  initialEpisodeId,
  demo,
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
  const [demoing, setDemoing] = useState(demo);

  const active = data.runs.find((run) => run.runId === data.activeRunId) ?? null;

  async function start(input: StartRunInput) {
    setStarting(true);
    try {
      const { runId } = await apiSend<{ runId: string }>("/api/runs", "POST", input);
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

  // The guided demo: one link from Home to a day already playing. It has to work
  // on a machine with nothing saved, so it stands the scenario up first.
  const demoStarted = useRef(false);
  useEffect(() => {
    if (!demo || demoStarted.current) return;
    demoStarted.current = true;

    void (async () => {
      try {
        const saved = episodes.find((e) => e.templateId === DEMO_TEMPLATE);
        const episodeId =
          saved?.id ??
          (
            await apiSend<{ episode: EpisodeRecord }>("/api/episodes", "POST", {
              templateId: DEMO_TEMPLATE,
            })
          ).episode.id;

        const { runId } = await apiSend<{ runId: string }>("/api/runs", "POST", {
          episodeId,
          model: defaultModel,
          twins: [],
          ticks: 24,
        });
        router.replace(`/runs/${runId}`);
      } catch (err) {
        setDemoing(false);
        toast({
          title: "Could not set up the demo",
          description: (err as Error).message,
          tone: "error",
        });
      }
    })();
  }, [demo, episodes, defaultModel, router, toast]);

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        title="Runs"
        subtitle="A run is one simulated workday. Pick a scenario and a model, press start, and watch the day play out — emails arriving, the agent working, people writing back."
        actions={
          active ? (
            <Button
              variant="primary"
              iconRight={<IconArrowRight size={14} />}
              onClick={(e) => go(e, `/runs/${active.runId}`)}
            >
              Watch the day
            </Button>
          ) : undefined
        }
      />

      <StaleNotice poll={poll} what="the run list" />

      {demoing ? (
        <Card padding="lg" className="animate-sn-rise">
          <div className="flex items-center gap-4">
            <Spinner size="md" />
            <div>
              <p className="text-[14px] font-medium text-sn-ink">Setting up your first day…</p>
              <p className="mt-1 text-[13px] text-sn-muted">
                Cloning Northbeam Capital, then starting the client-escalation day. This takes a
                couple of seconds.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {active ? <LiveRunBanner run={active} now={data.at} onOpen={(e) => go(e, `/runs/${active.runId}`)} /> : null}

      <section>
        <h2 className="font-display text-[26px] text-sn-ink">Start a run</h2>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-[21px] text-sn-muted">
          The scenario decides what happens and what counts as done. The model is the thing being
          tested — everyone else in the company is played by the harness.
        </p>
        <div className="mt-5">
          <StartRunPanel
            episodes={episodes}
            defaultModel={defaultModel}
            beatTicks={beatTicks}
            initialEpisodeId={initialEpisodeId}
            starting={starting}
            onStart={(input) => void start(input)}
          />
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-[26px] text-sn-ink">Past runs</h2>
          {/* NOT "on this machine". This list is `/api/runs`, which reads the
              dashboard's own document store; runs started by the CLI land in the
              artifact directory, and only there. Saying "on this machine" over
              one of two stores is how this page claimed 1 run while the old
              results page counted 11 of the same days. The benchmark reads the
              full record, so the outbound link goes there. */}
          <div className="flex items-center gap-3 text-[12px] text-sn-subtle">
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
        </div>
        <div className="mt-5">
          <PastRuns runs={data.runs} now={data.at} simulated={simulated} />
        </div>
      </section>
    </div>
  );
}

function LiveRunBanner({
  run,
  now,
  onOpen,
}: {
  run: RunSummary;
  now: number;
  onOpen: (event: MouseEvent<HTMLElement>) => void;
}) {
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
          <h2 className="mt-3 font-display text-[28px] text-sn-ink">{run.specTitle}</h2>
          <p className="mt-1 text-[13px] text-sn-subtle">
            {elapsed(run.startedAt, run.endedAt ?? now)} of real time so far
          </p>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Simulated time
            </p>
            <p data-numeric className="font-display-upright mt-1 text-[40px] leading-none text-sn-ink">
              {simClock(run.simTimeISO)}
            </p>
          </div>
          <Button variant="primary" size="lg" iconRight={<IconArrowRight size={15} />} onClick={onOpen}>
            Watch the day
          </Button>
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
