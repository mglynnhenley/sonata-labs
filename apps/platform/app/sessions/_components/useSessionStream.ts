"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus, TickRecord } from "@sonata/core";
import { apiGet, apiSend } from "../../api/_lib/client";
import type { SessionPoll, SessionView } from "../../api/sessions/_lib/types";
import { pollIntervalMs } from "../_lib/pulse";

// The live channel for a session.
//
// The same watermark poll a run uses — deliberately, because it is the same
// problem: whole paragraphs of state arriving on the world's own schedule. What
// differs is the rate. A run produces a tick as fast as the model answers; a
// session produces one every `realMsPerTick`, which at real time is fifteen
// minutes, so the interval is derived from the world's clock rather than fixed
// at a second. Nothing new can appear between two ticks anyway: the agent's work
// is read out of the audit logs at a tick boundary.

const LIVE_STATUSES: readonly RunStatus[] = ["queued", "running", "judging"];

export interface SessionStream {
  session: SessionView;
  ticks: TickRecord[];
  /** True while the world is still playing. */
  live: boolean;
  /** Last poll failure. The day already on screen stays on screen. */
  error: string | null;
  /** Server clock at the last successful poll, for countdowns that must not drift. */
  serverAt: number;
  stop: () => Promise<void>;
  stopping: boolean;
}

export function useSessionStream(initial: SessionPoll): SessionStream {
  const [session, setSession] = useState<SessionView>(initial.session);
  const [ticks, setTicks] = useState<TickRecord[]>(initial.ticks);
  const [error, setError] = useState<string | null>(null);
  const [serverAt, setServerAt] = useState(initial.at);
  const [stopping, setStopping] = useState(false);

  // Watermark and liveness live in refs so the poll loop reads them without
  // being rebuilt every time a tick lands.
  const since = useRef(initial.nextSinceTick);
  const alive = useRef(true);

  const merge = useCallback((poll: SessionPoll) => {
    setSession(poll.session);
    setServerAt(poll.at);
    since.current = poll.nextSinceTick;
    if (poll.ticks.length > 0) {
      setTicks((current) => {
        const seen = new Set(current.map((t) => t.tick));
        const added = poll.ticks.filter((t) => !seen.has(t.tick));
        return added.length === 0 ? current : [...current, ...added];
      });
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const poll = await apiGet<SessionPoll>(
        `/api/sessions/${initial.session.sessionId}?sinceTick=${since.current}`,
      );
      if (!alive.current) return;
      merge(poll);
      setError(null);
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    }
  }, [initial.session.sessionId, merge]);

  const live = LIVE_STATUSES.includes(session.status);
  const interval = pollIntervalMs(session.realMsPerTick);

  useEffect(() => {
    alive.current = true;
    if (!live) return () => void (alive.current = false);

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void load(), interval);
    };
    const stopPolling = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    // A backgrounded tab must not keep asking. It catches up in one poll, which
    // is the whole advantage of a watermark over a stream.
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else {
        void load();
        start();
      }
    };

    void load();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, interval, load]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      const { session: updated } = await apiSend<{ session: SessionView }>(
        `/api/sessions/${initial.session.sessionId}`,
        "DELETE",
      );
      if (!alive.current) return;
      setSession(updated);
      setError(null);
      // Stopping writes the artifact and the score; ask for them straight away
      // rather than waiting out an interval that may be fifteen minutes long.
      await load();
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      if (alive.current) setStopping(false);
    }
  }, [initial.session.sessionId, load]);

  return { session, ticks, live, error, serverAt, stop, stopping };
}
