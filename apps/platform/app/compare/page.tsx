import { listRuns } from "../results/_lib/artifacts";
import { buildBenchmark, summarizeRun } from "../results/_lib/summary";
import { CompareClient, type CompareView } from "./CompareClient";

// The benchmark's front door: the leaderboard first — the ranking the article
// leads with — and the model-by-scenario matrix one tab away. Reads the
// artifact directory on every request; runs are written by a separate process,
// so anything cached here would be stale the moment one ends.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Results",
  description: "Models ranked by autonomy, and models against scenarios: failures and cost per day.",
};

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const benchmark = buildBenchmark(listRuns().map(summarizeRun));
  const { view } = await searchParams;
  const active: CompareView = view === "matrix" ? "matrix" : "leaderboard";

  return <CompareClient benchmark={benchmark} view={active} />;
}
