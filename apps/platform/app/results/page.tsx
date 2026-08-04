import { listRuns } from "./_lib/artifacts";
import { summarizeRun } from "./_lib/summary";
import { ResultsExplorer } from "./_components/ResultsExplorer";

// The index reads the artifact directory on every request: runs are written by a
// separate process, so anything cached here would be stale the moment a run
// finished. Reading a few hundred JSON files is microseconds; a stale results
// page is the one thing this product cannot afford.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Results",
  description: "Every finished run, its score, its failure modes and the benchmark table.",
};

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ spec?: string; model?: string; view?: string }>;
}) {
  const { spec, model, view } = await searchParams;
  const runs = listRuns().map(summarizeRun);

  // Keyed on the query, because the filters are client state seeded from it: a
  // benchmark cell linking to ?spec=…&model=… lands on this same route, and
  // without a remount the URL would change while the chips stayed put.
  return (
    <ResultsExplorer
      key={`${spec ?? ""}|${model ?? ""}|${view ?? ""}`}
      runs={runs}
      initialSpec={spec ?? "all"}
      initialModel={model ?? "all"}
      initialView={view === "benchmark" ? "benchmark" : "runs"}
    />
  );
}
