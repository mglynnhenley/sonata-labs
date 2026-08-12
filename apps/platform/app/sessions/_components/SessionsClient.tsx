"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  buttonClasses,
  Card,
  Chip,
  EmptyState,
  IconArrowRight,
  IconClock,
  PageHeader,
  ProgressBar,
  Table,
  useToast,
  type BadgeStatus,
  type Column,
} from "@sonata/ui";
import type { RunStatus, TwinName } from "@sonata/core";
import { ago, elapsed, percent, simClock } from "@/lib/format";
import { StaleNotice } from "../../_components/StaleNotice";
import { useGo } from "../../_components/useGo";
import { usePoll } from "../../_components/usePoll";
import { apiSend } from "../../api/_lib/client";
import type {
  SessionScenario,
  SessionView,
  SessionsFeed,
  StartSessionInput,
} from "../../api/sessions/_lib/types";
import { compressionLabel, readPulse } from "../_lib/pulse";
import { ConnectPanel } from "./ConnectPanel";
import { StartSessionPanel } from "./StartSessionPanel";

// The Sessions page: plug an agent in, start the world, watch it from here or
// from the session's own page. The live view is the hero and lives at
// /sessions/[sessionId] — this page only ever shows the door to it.

const LIVE: readonly RunStatus[] = ["queued", "running", "judging"];

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
  judging: "Reading it back",
  done: "Played to the end",
  failed: "Errored",
  aborted: "Stopped early",
};

export type SessionsClientProps = {
  initial: SessionsFeed;
  scenarios: readonly SessionScenario[];
  twins: readonly { twin: TwinName; url: string; ok: boolean; detail: string }[];
};

export function SessionsClient({ initial, scenarios, twins }: SessionsClientProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();
  const poll = usePoll<SessionsFeed>("/api/sessions", 3000, initial);
  const { data } = poll;
  const [starting, setStarting] = useState(false);

  const live = data.sessions.filter((s) => LIVE.includes(s.status));
  const past = data.sessions.filter((s) => !LIVE.includes(s.status));

  async function start(input: StartSessionInput) {
    setStarting(true);
    try {
      const { session } = await apiSend<{ session: SessionView }>("/api/sessions", "POST", input);
      // Deliberately left spinning: the button keeps its state until the live
      // view has actually replaced this page.
      router.push(`/sessions/${session.sessionId}`);
    } catch (err) {
      setStarting(false);
      toast({
        title: "The world did not start",
        description: (err as Error).message,
        tone: "error",
      });
    }
  }

  return (
    <div className="sn-stack-section">
      <PageHeader
        title="Sessions"
        subtitle="A session is a simulated workday running at an agent Sonata never calls. Emails land, people answer, the calendar moves — on a wall clock, at whatever speed you choose. Your agent notices by checking its own inbox, and everything it does is scored the same way a benchmark run is."
        actions={
          live[0] ? (
            // A real anchor, so the live session can be opened in its own tab.
            <a
              href={`/sessions/${live[0].sessionId}`}
              onClick={(e) => go(e, `/sessions/${live[0].sessionId}`)}
              className={buttonClasses("primary", "md")}
            >
              Watch the day
              <IconArrowRight size="sm" />
            </a>
          ) : undefined
        }
      />

      <StaleNotice poll={poll} what="the session list" />

      {live.map((session) => (
        <LiveBanner
          key={session.sessionId}
          session={session}
          now={data.at}
          href={`/sessions/${session.sessionId}`}
        />
      ))}

      <ConnectPanel twins={twins} />

      <section>
        <h2 className="font-display text-[26px] text-sn-ink">Start a session</h2>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-[21px] text-sn-muted">
          The scenario decides what happens and what counts as done. Nobody plays the agent — that
          is the seat your own is sitting in.
        </p>
        <div className="mt-6">
          <StartSessionPanel
            scenarios={scenarios}
            starting={starting}
            onStart={(input) => void start(input)}
          />
        </div>
      </section>

      <section>
        <h2 className="font-display text-[26px] text-sn-ink">Past sessions</h2>
        <div className="mt-6">
          <PastSessions sessions={past} now={data.at} />
        </div>
      </section>
    </div>
  );
}

function LiveBanner({
  session,
  now,
  href,
}: {
  session: SessionView;
  now: number;
  /** The session's own page. Passed as a URL, not a handler, so the banner's way
   *  in is a real link. */
  href: string;
}) {
  const go = useGo();
  const pulse = readPulse(session, now);
  return (
    <Card padding="lg" className="animate-sn-rise">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge status="running" dot>
              {LABEL[session.status]}
            </Badge>
            <Chip>{session.agentLabel}</Chip>
            <span className="text-[12px] text-sn-subtle">
              {compressionLabel(session.compression)}
            </span>
          </div>
          <h2 className="mt-3 font-display text-[28px] text-sn-ink">{session.title}</h2>
          <p className="mt-1 text-[13px] text-sn-subtle">
            {pulse.title} · {elapsed(session.startedAt, now)} of real time so far
          </p>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
              Simulated time
            </p>
            <p data-numeric className="font-display-upright mt-1 text-[40px] leading-none text-sn-ink">
              {simClock(session.simTimeISO)}
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
          value={session.tick}
          max={session.plannedTicks}
          label="The day so far"
          showValue
          valueLabel={`Interval ${session.tick} of ${session.plannedTicks}`}
          indeterminate={session.status === "queued" || session.status === "judging"}
        />
      </div>
    </Card>
  );
}

function PastSessions({ sessions, now }: { sessions: readonly SessionView[]; now: number }) {
  const router = useRouter();

  const columns: readonly Column<SessionView>[] = [
    {
      key: "day",
      header: "The day",
      render: (session) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-sn-ink">{session.title}</p>
          <p className="mt-0.5 text-[12px] text-sn-subtle">
            {session.agentLabel} · {compressionLabel(session.compression)}
          </p>
        </div>
      ),
    },
    {
      key: "when",
      header: "When",
      width: "120px",
      render: (session) => <span className="text-sn-muted">{ago(session.startedAt, now)}</span>,
    },
    {
      key: "took",
      header: "Took",
      align: "right",
      width: "90px",
      render: (session) => (
        <span data-numeric className="text-sn-muted">
          {elapsed(session.startedAt, session.endedAt ?? now)}
        </span>
      ),
    },
    {
      key: "actions",
      // The number that says whether anything was plugged in at all. It is the
      // first thing to look at on a session and the reason this column is not
      // the score.
      header: "Agent changes",
      align: "right",
      width: "120px",
      render: (session) => (
        <span
          data-numeric
          className={session.agentActions === 0 ? "text-sn-subtle" : "text-sn-ink"}
        >
          {session.agentActions}
        </span>
      ),
    },
    {
      key: "autonomy",
      header: "Autonomy",
      align: "right",
      width: "100px",
      render: (session) => (
        <span data-numeric className={session.autonomy === null ? "text-sn-subtle" : "text-sn-ink"}>
          {percent(session.autonomy)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Ended",
      align: "right",
      width: "150px",
      render: (session) => (
        <Badge status={BADGE[session.status]} size="sm">
          {LABEL[session.status]}
        </Badge>
      ),
    },
  ];

  return (
    <Table
      columns={columns}
      rows={sessions}
      rowKey={(session) => session.sessionId}
      rowLabel={(session) => `${session.title} with ${session.agentLabel}`}
      // The href is what Cmd-click and middle-click use; the handler routes on
      // the client for a plain click. See PastRuns for the same pairing.
      rowHref={(session) => `/sessions/${session.sessionId}`}
      onRowClick={(session) => router.push(`/sessions/${session.sessionId}`)}
      caption="Past sessions, newest first"
      empty={
        <EmptyState
          size="sm"
          icon={<IconClock size="lg" />}
          title="No sessions yet"
          description="Start the world above, point your agent at the three clones, and the day it works through lands here — with what it changed, what it ignored, and the same score a benchmark run gets."
          hints={[
            "Nothing is required of the agent beyond using the tools",
            "A session that ends is filed in Results beside the benchmark runs",
          ]}
        />
      }
    />
  );
}
