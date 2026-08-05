import { PageHeader } from "@sonata/ui";
import { listRuns } from "../results/_lib/artifacts";
import { buildBenchmark, summarizeRun } from "../results/_lib/summary";
import { BenchmarkTable } from "../results/_components/BenchmarkTable";

// The deliverable's front door: the model-by-scenario table, promoted out of a
// pill. Reads the artifact directory on every request — runs are written by a
// separate process, so anything cached here would be stale the moment one ends.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare",
  description: "Models against scenarios: autonomy per day, repeat failure modes and cost.",
};

export default function ComparePage() {
  const benchmark = buildBenchmark(listRuns().map(summarizeRun));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Compare"
        title="Which model handled the day"
        subtitle="Rows are models, columns are scenarios, and every cell opens the run that produced it. Autonomy is the share of the day's work your agent finished without handing it back to a human."
      />
      <BenchmarkTable benchmark={benchmark} />
    </div>
  );
}
