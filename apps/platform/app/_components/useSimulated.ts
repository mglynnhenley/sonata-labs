"use client";

import { useEffect, useState } from "react";

// Which of Home's rows were fabricated by the old stand-in loop.
//
// Home is built from the relational rows, and a row records a score and a status
// and nothing about whether a model was ever called. The rows are already honest
// about the arithmetic — a fabricated run's score is null, so it is in no mean —
// but "no result" is also what a crash says, and Home would print one grey badge
// over both. The naming has to come from the artifacts, so it comes from
// /api/results/simulated.
//
// Fetched ONCE per mount rather than polled: the set only changes when a run is
// pruned, that is a terminal command, and the endpoint parses every artifact on
// disk. A page that polled it would pay for the whole runs directory every few
// seconds to answer a question whose answer is fixed.
//
// Failure is silence. If the fetch does not land, Home renders exactly what it
// rendered before — no number moves, because the exclusion is already in the
// rows; only the word on the badge is missing.

interface SimulatedResponse {
  runIds?: string[];
}

export function useSimulated(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/results/simulated", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as SimulatedResponse;
        setIds(new Set(body.runIds ?? []));
      } catch {
        // Aborted, offline, or the directory would not read. Nothing to say.
      }
    })();
    return () => abort.abort();
  }, []);

  return ids;
}
