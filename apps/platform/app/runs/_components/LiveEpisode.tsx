"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  Chip,
  IconAlert,
  IconArrowDown,
  IconArrowRight,
  IconCheck,
  PageHeader,
  ProgressBar,
  SERVICE_LABELS,
  type BadgeStatus,
} from "@sonata/ui";
import type { RunStatus, TwinName } from "@sonata/core";
import { dayRange, elapsed, money, percent, simClock } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { useGo } from "../../_components/useGo";
import { buildStory, tally } from "../_lib/story";
import type { RunDetail } from "../../api/_lib/types";
import { RunTimeline } from "./RunTimeline";
import { useRunStream } from "./useRunStream";

// The hero. One simulated day as a single vertical story, anchored on the clock:
// what fired, what the agent did, what the world said back. Live while it plays,
// and the same rows afterwards — a run must not look one way live and another
// way in the replay.

const STATUS_BADGE: Record<RunStatus, BadgeStatus> = {
  queued: "pending",
  running: "running",
  judging: "running",
  done: "passed",
  failed: "failed",
  aborted: "neutral",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Starting",
  running: "Running",
  judging: "Reading the day back",
  done: "Finished",
  failed: "Stopped by an error",
  aborted: "Stopped early",
};

export type LiveEpisodeProps = {
  initial: RunDetail;
  /** Where the three clones are, so every row and the header open the world. */
  twinLinks: readonly { twin: TwinName; url: string }[];
};

export function LiveEpisode({ initial, twinLinks }: LiveEpisodeProps) {
  const go = useGo();
  const { run, ticks, live, error, command, pending } = useRunStream(initial);

  const rows = useMemo(() => buildStory(ticks), [ticks]);
  const counts = useMemo(() => tally(rows), [rows]);

  // Follow the day as it happens, but never yank the page out from under
  // someone who has scrolled back to read something.
  const scroller = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [seen, setSeen] = useState(rows.length);

  // Only rows that arrived on the last poll get the slide-in. Derived during
  // render rather than in an effect, so a row never paints still and then moves.
  const [span, setSpan] = useState({ from: rows.length, to: rows.length });
  if (span.to !== rows.length) setSpan({ from: span.to, to: rows.length });

  useEffect(() => {
    const node = scroller.current;
    if (!node || !follow) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length, follow]);

  useEffect(() => {
    if (follow) setSeen(rows.length);
  }, [rows.length, follow]);

  // Wall-clock elapsed has to keep moving between polls, or the run looks stuck.
  // Seeded from the server's own reckoning rather than `Date.now()`, so the
  // server paint and the hydrated first render show the same number.
  const [now, setNow] = useState(() => initial.startedAt + initial.durationMs);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const finished = !live;
  const behind = rows.length - seen;

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
    setFollow(atBottom);
  }

  function jumpToNow() {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
    setFollow(true);
  }

  // The same address this page is on: once the day is over, /runs/{id} serves
  // the verdict, so "see the results" is a re-render rather than another page.
  const resultsHref = `/runs/${run.runId}`;

  return (
    <div className="sn-stack-section">
      <PageHeader
        eyebrow={`Run · ${run.runId}`}
        title={run.specTitle}
        subtitle={initial.story}
        meta={
          <>
            <Badge status={STATUS_BADGE[run.status]} dot={run.status === "running"}>
              {STATUS_LABEL[run.status]}
            </Badge>
            <Chip>{modelLabel(run.model)}</Chip>
            {run.twins.map((twin) => (
              <Chip key={twin} service={twin} size="md">
                {SERVICE_LABELS[twin]}
              </Chip>
            ))}
          </>
        }
        actions={
          <>
            {live ? (
              // Stop, and no Pause. A day is a chain of live model calls with
              // nothing to freeze between them, so `pauseRun` refuses — this
              // button POSTed that refusal straight back as a 500. Offering a
              // control the engine cannot honour is the same defect as printing a
              // number nothing measured, so the control goes.
              <Button
                variant="ghost"
                loading={pending === "abort"}
                onClick={() => void command("abort")}
              >
                Stop the day
              </Button>
            ) : (
              // Stop is an action and stays a button; the verdict is an address,
              // so it is a real anchor wearing the button's clothes.
              <a
                href={resultsHref}
                onClick={(e) => go(e, resultsHref)}
                className={buttonClasses("primary", "md")}
              >
                See the verdict
                <IconArrowRight size="sm" />
              </a>
            )}
          </>
        }
      />

      {run.error ? (
        <Card padding="md" className="border-sn-failed-line bg-sn-failed-soft">
          <div className="flex items-start gap-2.5">
            <IconAlert size="md" className="mt-0.5 shrink-0 text-sn-danger" />
            <p className="text-sn-base text-sn-failed-ink">{run.error}</p>
          </div>
        </Card>
      ) : null}

      <Card padding="lg">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
          <div>
            <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Simulated time
            </p>
            <p data-numeric className="font-display-upright mt-1 text-sn-5xl leading-none text-sn-ink">
              {simClock(run.simTimeISO)}
            </p>
            <p className="mt-1.5 text-sn-sm text-sn-subtle">
              {dayRange(initial.clock.startISO, initial.clock.simMinutesPerTick, run.plannedTicks)}
            </p>
          </div>

          <div className="min-w-[260px] flex-1">
            <ProgressBar
              value={run.tickCount}
              max={run.plannedTicks}
              tone={finished ? "success" : "primary"}
              label={finished ? "The day, in full" : "The day so far"}
              showValue
              valueLabel={`Tick ${run.tickCount} of ${run.plannedTicks}`}
              indeterminate={run.status === "queued" || run.status === "judging"}
            />
            <p className="mt-2 text-sn-sm text-sn-subtle">
              {elapsed(run.startedAt, run.endedAt ?? now)} of real time
              {run.cost ? ` · ${money(run.cost.usd)} spent` : ""}
              {run.score !== null ? ` · ${percent(run.score)} of the checklist` : ""}
            </p>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-sn-line pt-5 sm:grid-cols-4">
          <Tally label="Arrived" value={counts.arrivals} hint="emails, posts, invites" />
          <Tally label="People answered" value={counts.replies} hint="because of the agent" />
          <Tally label="Agent acted" value={counts.agentActions} hint="writes to an app" />
          <Tally
            label="Handed back"
            value={counts.escalations}
            hint="what autonomy costs"
            alarm={counts.escalations > 0}
          />
        </dl>

        {twinLinks.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-sn-line pt-5">
            <span className="text-sn-sm text-sn-subtle">Watch it happen in the apps:</span>
            {twinLinks.map((link) => (
              <a key={link.twin} href={link.url} target="_blank" rel="noreferrer">
                <Chip service={link.twin} size="sm">
                  Open {SERVICE_LABELS[link.twin]}
                </Chip>
              </a>
            ))}
          </div>
        ) : null}
      </Card>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-sn-line px-6 py-4">
          <h2 className="font-display text-sn-2xl text-sn-ink">The day, as it happened</h2>
          {/* The count is the live region, not the story below it: a screen
              reader given the list would read every arriving row aloud over
              whatever the listener was already reading. This says how much has
              happened, once, and stays out of the way. */}
          <span aria-live="polite" className="text-sn-sm text-sn-subtle">
            {rows.length} moment{rows.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {error ? (
              <span className="text-sn-sm text-sn-subtle">Reconnecting…</span>
            ) : live ? (
              <Badge status="running" size="sm" dot>
                Live
              </Badge>
            ) : null}
            {!follow && live ? (
              <Button size="sm" variant="secondary" icon={<IconArrowDown size="sm" />} onClick={jumpToNow}>
                {behind > 0 ? `${behind} new` : "Jump to now"}
              </Button>
            ) : null}
          </div>
        </div>

        <div
          ref={scroller}
          onScroll={onScroll}
          // `overscroll-contain`: hitting the end of the story must not carry on
          // and scroll the page out from under someone reading it.
          className="sn-scroll max-h-[62vh] min-h-[360px] overflow-y-auto overscroll-contain px-6 py-6"
        >
          {rows.length === 0 ? (
            <p className="py-16 text-center text-sn-base text-sn-subtle">
              The day has not started yet. The first thing usually happens around 09:15.
            </p>
          ) : (
            <RunTimeline rows={rows} freshFrom={span.from} />
          )}

          {finished ? (
            <div className="mt-2 flex items-center gap-2.5 rounded-sn-lg bg-sn-bg-subtle px-4 py-3">
              <IconCheck size="sm" className="shrink-0 text-sn-success" />
              <p className="text-sn-base text-sn-muted">
                The day is over. The verdict has the score, the criteria behind it and the
                failure modes the judge found.
              </p>
              <a
                href={resultsHref}
                onClick={(e) => go(e, resultsHref)}
                className="ml-auto shrink-0 text-sn-base font-medium text-sn-primary-ink hover:underline"
              >
                Read the verdict
              </a>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function Tally({
  label,
  value,
  hint,
  alarm = false,
}: {
  label: string;
  value: number;
  hint: string;
  alarm?: boolean;
}) {
  return (
    <div>
      <dt className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">{label}</dt>
      <dd
        data-numeric
        className={`mt-1 text-sn-2xl leading-none ${alarm ? "text-sn-danger-ink" : "text-sn-ink"}`}
      >
        {value}
      </dd>
      <p className="mt-1 text-sn-sm text-sn-subtle">{hint}</p>
    </div>
  );
}
