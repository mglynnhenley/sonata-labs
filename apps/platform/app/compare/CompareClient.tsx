"use client";

import { useRouter } from "next/navigation";
import { PageHeader, Tabs } from "@sonata/ui";
import type { Benchmark } from "../results/_lib/summary";
import { BenchmarkTable } from "../results/_components/BenchmarkTable";
import { Leaderboard } from "./Leaderboard";

// Two views of one dataset: the leaderboard answers "which model is best
// overall", the matrix answers "where do models diverge". One page, because a
// second nav entry for a second projection of the same runs is the wrong trade.

export type CompareView = "leaderboard" | "matrix";

const TABS = [
  { id: "leaderboard", label: "Leaderboard" },
  { id: "matrix", label: "By scenario" },
] as const;

export function CompareClient({ benchmark, view }: { benchmark: Benchmark; view: CompareView }) {
  const router = useRouter();

  return (
    <div className="sn-stack-section">
      <PageHeader
        eyebrow="Results"
        title="Which model handled the day"
        subtitle="Autonomy is the share of the day's work your agent finished without handing it back to a human. Every number opens the run that produced it."
      />
      <Tabs
        items={TABS}
        value={view}
        // The view lives in the URL, so a specific table can be linked from the
        // article draft — replace, not push: flipping views is not a history event.
        onValueChange={(id) => router.replace(id === "matrix" ? "/compare?view=matrix" : "/compare")}
        label="Comparison views"
      />
      {view === "matrix" ? <BenchmarkTable benchmark={benchmark} /> : <Leaderboard benchmark={benchmark} />}
    </div>
  );
}
