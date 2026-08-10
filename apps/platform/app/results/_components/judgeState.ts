"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { JudgeState } from "../../api/results/_lib/judgeAttempt";

// WHERE THE DIAGNOSIS HAS GOT TO, for the four sections that have to say it.
//
// A run judges itself when it ends, so the sections below the score have three
// states to tell apart and only ever had two: a report, or nothing. Nothing is
// what a page shows while the judge is still reading, and it is what a page
// shows when the judge answered and was cut off mid-sentence — and a reader
// staring at an empty Failure Modes section has no way to tell those apart, or
// to know whether pressing the button again would cost them a dollar for the
// same silence.
//
// The state is fetched rather than passed down because these components take the
// props the page has always given them (`judge`, `cost`), and the run id is in
// the URL — which is the one thing every one of them can reach. One request per
// run, shared: the store below is what stops four sections asking four times.

export type { JudgeState } from "../../api/results/_lib/judgeAttempt";

/** A pass in flight is minutes long, so this is a heartbeat, not a stream. */
const POLL_MS = 4000;

type Listener = (state: JudgeState | null) => void;

interface Entry {
  state: JudgeState | null;
  listeners: Set<Listener>;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<string, Entry>();

function entryFor(runId: string): Entry {
  const found = entries.get(runId);
  if (found) return found;
  const created: Entry = { state: null, listeners: new Set(), inFlight: null, timer: null };
  entries.set(runId, created);
  return created;
}

function load(runId: string): Promise<void> {
  const entry = entryFor(runId);
  // One request, however many sections asked for it in the same paint.
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = (async () => {
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(runId)}/judge`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const state = (await res.json()) as JudgeState;
      entry.state = state;
      for (const listener of entry.listeners) listener(state);
    } catch {
      // A page that cannot reach its own API keeps the last thing it knew. The
      // sections all render something without this; none of them render a lie.
    } finally {
      entry.inFlight = null;
    }
  })();
  return entry.inFlight;
}

function sync(runId: string): void {
  const entry = entryFor(runId);
  const wanted = entry.listeners.size > 0 && entry.state?.state === "judging";
  if (wanted && entry.timer === null) {
    entry.timer = setInterval(() => void load(runId), POLL_MS);
  } else if (!wanted && entry.timer !== null) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

/** The run this page is about, from the URL every results view is mounted under. */
function useRunIdFromUrl(): string | null {
  const params = useParams();
  const raw = params?.runId;
  if (typeof raw === "string") return raw;
  return Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;
}

/**
 * Null until the first answer lands — which is the honest state, and the reason
 * every caller renders what it was given by the server first.
 *
 * When a pass that was in flight finishes, the page is refreshed: the report is
 * server-rendered from the artifact, so this hook learning about it is no use on
 * its own.
 */
export function useJudgeState(): JudgeState | null {
  const router = useRouter();
  const runId = useRunIdFromUrl();
  const [state, setState] = useState<JudgeState | null>(() =>
    runId ? entries.get(runId)?.state ?? null : null,
  );
  const wasJudging = useRef(false);

  useEffect(() => {
    if (!runId) return;
    const entry = entryFor(runId);
    const listener: Listener = (next) => setState(next);
    entry.listeners.add(listener);
    setState(entry.state);
    void load(runId).then(() => sync(runId));
    sync(runId);
    return () => {
      entry.listeners.delete(listener);
      sync(runId);
    };
  }, [runId]);

  useEffect(() => {
    if (state?.state === "judging") {
      wasJudging.current = true;
      return;
    }
    if (wasJudging.current && state) {
      wasJudging.current = false;
      router.refresh();
    }
  }, [state, router]);

  return state;
}
