"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus, TickRecord } from "@sonata/core";
import { apiGet, apiSend } from "../../api/_lib/client";
import type { RunCommand, RunDetail, RunPoll, RunSummary } from "../../api/_lib/types";

// The live channel for a running day.
//
// Polling with a watermark rather than SSE: a tick is a whole paragraph of state
// and lands about once a second, so a plain GET that asks for "everything after
// tick N" is simpler, survives a dropped connection with no reconnect logic, and
// makes a browser refresh mid-run cost nothing.

const LIVE_STATUSES: readonly RunStatus[] = ["queued", "running", "judging"];

/** Idle when paused: nothing is being produced, so nothing needs asking for. */
const RUNNING_MS = 1000;
const PAUSED_MS = 4000;

export interface RunStream {
  run: RunSummary;
  ticks: TickRecord[];
  /** True while the day is still being produced. */
  live: boolean;
  /** Last poll failure. The story already on screen stays on screen. */
  error: string | null;
  /** Pause / resume / abort. Resolves once the new state is on screen. */
  command: (command: RunCommand) => Promise<void>;
  /** In flight, so the button that sent it can spin. */
  pending: RunCommand | null;
}

export function useRunStream(initial: RunDetail): RunStream {
  const { ticks: initialTicks, story: _story, task: _task, clock: _clock, ...initialRun } = initial;

  const [run, setRun] = useState<RunSummary>(initialRun);
  const [ticks, setTicks] = useState<TickRecord[]>(initialTicks);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RunCommand | null>(null);

  // Watermark and liveness live in refs: the poll loop reads them without being
  // rebuilt every time a tick lands.
  const since = useRef(initial.tickCount);
  const alive = useRef(true);

  const merge = useCallback((poll: RunPoll) => {
    setRun(poll.run);
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
      const poll = await apiGet<RunPoll>(`/api/runs/${initial.runId}?sinceTick=${since.current}`);
      if (!alive.current) return;
      merge(poll);
      setError(null);
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    }
  }, [initial.runId, merge]);

  const live = LIVE_STATUSES.includes(run.status);

  useEffect(() => {
    alive.current = true;
    if (!live) return () => void (alive.current = false);

    const interval = run.paused ? PAUSED_MS : RUNNING_MS;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => void load(), interval);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    // A backgrounded tab must not keep asking; it catches up in one poll.
    const onVisibility = () => {
      if (document.hidden) stop();
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
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, run.paused, load]);

  const command = useCallback(
    async (next: RunCommand) => {
      setPending(next);
      try {
        const { run: updated } = await apiSend<{ run: RunSummary }>(
          `/api/runs/${initial.runId}`,
          "PATCH",
          { command: next },
        );
        if (!alive.current) return;
        setRun(updated);
        setError(null);
        // Aborting writes a final tick and a score; ask for them straight away
        // rather than waiting out an interval that may already have stopped.
        await load();
      } catch (err) {
        if (alive.current) setError((err as Error).message);
      } finally {
        if (alive.current) setPending(null);
      }
    },
    [initial.runId, load],
  );

  return { run, ticks, live, error, command, pending };
}
