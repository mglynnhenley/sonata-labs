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
  IconInfo,
  PageHeader,
  ProgressBar,
  SERVICE_LABELS,
  cn,
  type BadgeStatus,
} from "@sonata/ui";
import type { RunStatus, TickRecord, TwinName } from "@sonata/core";
import { dayRange, elapsed, money, percent, simClock } from "@/lib/format";
import { useGo } from "../../_components/useGo";
import { buildStory, tally } from "../../runs/_lib/story";
import { RunTimeline } from "../../runs/_components/RunTimeline";
import type { SessionPoll, SessionView } from "../../api/sessions/_lib/types";
import {
  compressionLabel,
  nextTickIn,
  readPulse,
  sinceLabel,
  type PulseRead,
  type PulseTone,
} from "../_lib/pulse";
import { useSessionStream } from "./useSessionStream";

// THE HERO. A day running at an agent that is somebody else's process.
//
// The run view and this one draw the same timeline from the same projection on
// purpose — a moment must not read one way when the agent was ours and another
// way when it was not. Everything above the timeline is what a session needs and
// a run does not:
//
//   - the world's own clock, ticking on a wall-clock timer, with the countdown
//     to the next beat. At real time a tick is fifteen minutes, and a page with
//     no countdown looks like a page that has died.
//   - whether the agent is acting, in words and across the whole day at a
//     glance. Silence is the finding a session exists to catch, and an agent
//     that never connected has to be distinguishable from one that connected and
//     chose to do nothing.
//   - what this record cannot carry, once the day is over. Every gap here looks
//     like a finding about the agent if you do not know it is a gap.

const STATUS_BADGE: Record<RunStatus, BadgeStatus> = {
  queued: "pending",
  running: "running",
  judging: "running",
  done: "passed",
  failed: "failed",
  aborted: "neutral",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Standing the world up",
  running: "The world is running",
  judging: "Reading the day back",
  done: "Finished",
  failed: "Stopped by an error",
  aborted: "Stopped early",
};

export type LiveSessionProps = {
  initial: SessionPoll;
  /** Where the clones are, so the agent can be pointed at them from this page. */
  twinLinks: readonly { twin: TwinName; url: string }[];
};

export function LiveSession({ initial, twinLinks }: LiveSessionProps) {
  const go = useGo();
  const { session, ticks, live, error, serverAt, stop, stopping } = useSessionStream(initial);

  const rows = useMemo(() => buildStory(ticks), [ticks]);
  const counts = useMemo(() => tally(rows), [rows]);

  // Wall-clock now has to keep moving between polls or the countdown freezes and
  // the page looks broken. Seeded from the server's own clock so the first paint
  // and the hydrated render agree.
  const [now, setNow] = useState(serverAt);
  useEffect(() => {
    setNow(serverAt);
    if (!live) return;
    const timer = setInterval(() => setNow((current) => current + 1000), 1000);
    return () => clearInterval(timer);
  }, [serverAt, live]);

  const pulse = readPulse(session, now);
  const countdown = nextTickIn(session, now);
  const startISO = ticks[0]?.simTimeISO ?? session.simTimeISO;

  // Follow the day as it happens, but never yank the page out from under
  // someone who has scrolled back to read something.
  const scroller = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  const [seen, setSeen] = useState(rows.length);
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

  const behind = rows.length - seen;
  const resultsHref = `/runs/${session.sessionId}`;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={`Session · ${session.sessionId}`}
        title={session.title}
        subtitle={`The world plays at ${compressionLabel(session.compression)} whether or not the agent is looking. Nothing here calls it — everything below was read out of the clones.`}
        meta={
          <>
            <Badge status={STATUS_BADGE[session.status]} dot={live}>
              {STATUS_LABEL[session.status]}
            </Badge>
            <Chip>{session.agentLabel}</Chip>
            {session.twins.map((twin) => (
              <Chip key={twin} service={twin} size="md">
                {SERVICE_LABELS[twin]}
              </Chip>
            ))}
          </>
        }
        actions={
          live ? (
            <Button variant="ghost" loading={stopping} onClick={() => void stop()}>
              Stop the day
            </Button>
          ) : (
            // Stop is an action and stays a button; the results are an address,
            // so it is a real anchor wearing the button's clothes.
            <a
              href={resultsHref}
              onClick={(e) => go(e, resultsHref)}
              className={buttonClasses("primary", "md")}
            >
              See the results
              <IconArrowRight size={14} />
            </a>
          )
        }
      />

      {session.error ? (
        <Card padding="md" className="border-sn-failed-line bg-sn-failed-soft">
          <div className="flex items-start gap-2.5">
            <IconAlert size={15} className="mt-0.5 shrink-0 text-sn-danger" />
            <p className="text-[13px] leading-[20px] text-sn-failed-ink">{session.error}</p>
          </div>
        </Card>
      ) : null}

      <AgentPanel
        pulse={pulse}
        session={session}
        ticks={ticks}
        now={now}
        live={live}
        twinLinks={twinLinks}
      />

      <Card padding="lg">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
          <div>
            <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Simulated time
            </p>
            <p data-numeric className="font-display-upright mt-1 text-[52px] leading-none text-sn-ink">
              {simClock(session.simTimeISO)}
            </p>
            <p className="mt-1.5 text-[12px] text-sn-subtle">
              {dayRange(startISO, session.simMinutesPerTick, session.plannedTicks)} ·{" "}
              {compressionLabel(session.compression)}
            </p>
          </div>

          <div className="min-w-[260px] flex-1">
            <ProgressBar
              value={session.tick}
              max={session.plannedTicks}
              tone={live ? "primary" : "success"}
              label={live ? "The day so far" : "The day, in full"}
              showValue
              valueLabel={`Interval ${session.tick} of ${session.plannedTicks}`}
              indeterminate={session.status === "queued" || session.status === "judging"}
            />
            <p className="mt-2 text-[12px] text-sn-subtle">
              {elapsed(session.startedAt, session.endedAt ?? now)} of real time
              {live && countdown !== null ? ` · next interval in ${countdown}s` : ""}
              {session.costUsd > 0 ? ` · ${money(session.costUsd)} to run the world` : ""}
              {session.score !== null ? ` · ${percent(session.score)} of the checklist` : ""}
            </p>
          </div>
        </div>

        <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-sn-line pt-5 sm:grid-cols-4">
          <Tally label="Arrived" value={counts.arrivals} hint="emails, posts, invites" />
          <Tally label="People answered" value={counts.replies} hint="because of the agent" />
          <Tally label="Agent changed" value={session.agentActions} hint="writes the clones logged" />
          <Tally
            label="Handed back"
            value={counts.escalations}
            hint="only if the harness said so"
            alarm={counts.escalations > 0}
          />
        </dl>
      </Card>

      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-sn-line px-6 py-4">
          <h2 className="font-display text-[24px] text-sn-ink">The day, as it happened</h2>
          {/* The count is the live region, not the story below it: a screen
              reader given the list would read every arriving row aloud over
              whatever the listener was already reading. This says how much has
              happened, once, and stays out of the way. */}
          <span aria-live="polite" className="text-[12px] text-sn-subtle">
            {rows.length} moment{rows.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {error ? (
              <span className="text-[12px] text-sn-subtle">Reconnecting…</span>
            ) : live ? (
              <Badge status="running" size="sm" dot>
                Live
              </Badge>
            ) : null}
            {!follow && live ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<IconArrowDown size={13} />}
                onClick={() => {
                  const node = scroller.current;
                  if (node) node.scrollTop = node.scrollHeight;
                  setFollow(true);
                }}
              >
                {behind > 0 ? `${behind} new` : "Jump to now"}
              </Button>
            ) : null}
          </div>
        </div>

        <div
          ref={scroller}
          onScroll={() => {
            const node = scroller.current;
            if (!node) return;
            setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 60);
          }}
          // `overscroll-contain`: hitting the end of the story must not carry on
          // and scroll the page out from under someone reading it.
          className="sn-scroll max-h-[62vh] min-h-[360px] overflow-y-auto overscroll-contain px-6 py-6"
        >
          {rows.length === 0 ? (
            <p className="py-16 text-center text-[13px] text-sn-subtle">
              The world is being stood up. The first thing usually happens as soon as the day starts.
            </p>
          ) : (
            <RunTimeline rows={rows} freshFrom={span.from} />
          )}
        </div>
      </Card>

      {live ? null : <Closing session={session} resultsHref={resultsHref} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Is the agent doing anything?
// ---------------------------------------------------------------------------

const PULSE_BADGE: Record<PulseTone, BadgeStatus> = {
  running: "running",
  passed: "passed",
  failed: "failed",
  neutral: "neutral",
};

function AgentPanel({
  pulse,
  session,
  ticks,
  now,
  live,
  twinLinks,
}: {
  pulse: PulseRead;
  session: SessionView;
  ticks: readonly TickRecord[];
  now: number;
  live: boolean;
  twinLinks: readonly { twin: TwinName; url: string }[];
}) {
  const alarm = pulse.tone === "failed";
  return (
    <Card
      padding="lg"
      className={cn("animate-sn-rise", alarm ? "border-sn-failed-line bg-sn-failed-soft" : undefined)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[62ch]">
          <div className="flex items-center gap-2">
            <Badge status={PULSE_BADGE[pulse.tone]} dot={pulse.pulse === "acting"}>
              {pulse.pulse === "acting"
                ? "Acting"
                : pulse.pulse === "idle"
                  ? "Idle"
                  : pulse.pulse === "starting"
                    ? "Starting"
                    : "Ended"}
            </Badge>
            <span className="text-[12px] text-sn-subtle">{session.agentLabel}</span>
          </div>
          <h2 className="mt-3 font-display text-[28px] leading-[1.15] text-sn-ink">{pulse.title}</h2>
          <p className="mt-1.5 text-[13.5px] leading-[21px] text-sn-muted">{pulse.detail}</p>
        </div>

        <div className="text-right">
          <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
            Last change
          </p>
          <p data-numeric className="font-display-upright mt-1 text-[32px] leading-none text-sn-ink">
            {sinceLabel(session.lastAgentActionAt, now)}
          </p>
        </div>
      </div>

      <DayStrip session={session} ticks={ticks} />

      {live && twinLinks.length > 0 ? (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-sn-line pt-5">
          <span className="text-[12px] text-sn-subtle">
            Your agent works here — anything it changes shows up above:
          </span>
          {twinLinks.map((link) => (
            <a key={link.twin} href={link.url} target="_blank" rel="noreferrer">
              <Chip service={link.twin} size="sm">
                {SERVICE_LABELS[link.twin]} · {link.url.replace(/^https?:\/\//, "")}
              </Chip>
            </a>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The whole day in one line: one column per interval, tall where the agent
 * worked. A timeline says what happened; this says whether anyone was home —
 * a run of short columns is a morning the agent slept through, and it is
 * readable at arm's length.
 */
function DayStrip({
  session,
  ticks,
}: {
  session: SessionView;
  ticks: readonly TickRecord[];
}) {
  const byTick = new Map<number, TickRecord>();
  for (const record of ticks) byTick.set(record.tick, record);
  const columns = Array.from({ length: Math.max(session.plannedTicks, session.tick) }, (_, i) => i);

  return (
    <div className="mt-7">
      <div className="flex h-12 items-end gap-[3px]">
        {columns.map((index) => {
          const record = byTick.get(index);
          const played = index < session.tick;
          const agent = record?.agentSteps.length ?? 0;
          const world = (record?.beatsFired.length ?? 0) + (record?.directorEvents.length ?? 0);
          const height = agent > 0 ? "100%" : world > 0 ? "45%" : played ? "18%" : "12%";
          const tone =
            agent > 0
              ? "bg-sn-primary"
              : world > 0
                ? "bg-sn-gold"
                : played
                  ? "bg-sn-line-strong"
                  : "bg-sn-line";
          return (
            <span
              key={index}
              title={
                record
                  ? `${simClock(record.simTimeISO)} — ${agent} thing${agent === 1 ? "" : "s"} from the agent, ${world} from the world`
                  : "Not yet"
              }
              style={{ height }}
              className={cn("min-w-[3px] flex-1 rounded-[2px]", tone)}
            />
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-sn-subtle">
        <Key className="bg-sn-primary" label="the agent did something" />
        <Key className="bg-sn-gold" label="the world moved, the agent did not" />
        <Key className="bg-sn-line-strong" label="quiet" />
      </div>
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block h-2.5 w-2.5 rounded-[2px]", className)} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// After the day
// ---------------------------------------------------------------------------

function Closing({
  session,
  resultsHref,
}: {
  session: SessionView;
  /** Where the verdict lives. A URL rather than a handler, so the last thing on
   *  the page is a real link. */
  resultsHref: string;
}) {
  const go = useGo();
  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <IconCheck size={15} className="shrink-0 text-sn-success" />
        <h2 className="font-display text-[22px] text-sn-ink">
          {session.endedBecause ?? "The day is over."}
        </h2>
      </div>

      <p className="mt-2 max-w-[70ch] text-[13.5px] leading-[21px] text-sn-muted">
        {session.noResult
          ? session.noResult
          : "It was scored against the scenario's own checklist and read back by the judge — the same two passes a benchmark run gets, on the same artifact."}
      </p>

      {session.caveats.length > 0 ? (
        <div className="mt-6 rounded-sn-lg bg-sn-bg-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <IconInfo size={14} className="shrink-0 text-sn-subtle" />
            <p className="text-[13px] font-medium text-sn-ink">
              What this record cannot tell you
            </p>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[19px] text-sn-muted">
            The agent ran in its own process, so the day was reconstructed from what the clones
            logged. These gaps are on the artifact too, so nobody reading it later mistakes one for a
            finding about the agent.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {session.caveats.map((caveat) => (
              <li key={caveat} className="flex gap-2.5 text-[12.5px] leading-[19px] text-sn-muted">
                <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-sn-subtle" />
                {caveat}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-sn-line pt-5">
        <a
          href={resultsHref}
          onClick={(e) => go(e, resultsHref)}
          className={buttonClasses("primary", "md")}
        >
          Read the results
          <IconArrowRight size={14} />
        </a>
        <p className="text-[12px] text-sn-subtle">
          It sits in Results beside the benchmark runs, marked {session.model} so it is never read as
          a model's score.
        </p>
      </div>
    </Card>
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
      <dt className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">{label}</dt>
      <dd
        data-numeric
        className={cn("mt-1 text-[26px] leading-none", alarm ? "text-sn-danger-ink" : "text-sn-ink")}
      >
        {value}
      </dd>
      <p className="mt-1 text-[12px] text-sn-subtle">{hint}</p>
    </div>
  );
}
