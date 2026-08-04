"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Polling, once, for every live surface in the dashboard. The spec's rule is
// "live, never stale — no refresh button", so a page never asks to be reloaded:
// it keeps the last good value on screen, replaces it when a newer one arrives,
// and says so quietly if the server stops answering.

export interface Poll<T> {
  data: T;
  /** Set only after a failed fetch; the last good `data` stays on screen. */
  error: string | null;
  /** Epoch ms of the last successful response. */
  updatedAt: number;
  /** Fetch now — used after an action, so the UI does not wait out the interval. */
  refresh: () => void;
}

export function usePoll<T>(url: string, intervalMs: number, initial: T): Poll<T> {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  // A ref, not state, so `refresh` never changes identity and the effect below
  // is not torn down and rebuilt on every render.
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const next = (await res.json()) as T;
      if (!alive.current) return;
      setData(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void load(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    // A backgrounded tab must not keep hammering the twins; catch up on return.
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
  }, [load, intervalMs]);

  return { data, error, updatedAt, refresh: () => void load() };
}
