import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// WHICH CLOCK THIS DAY RAN ON.
//
// Stage 3 left two timing policies in the product, and results under them are
// not comparable: the compressed clock spends business time on provider latency,
// the operation-charge clock does not. The report says which one a run used, and
// it can only say so if the normaliser carries the saved field through — it used
// to drop it, so a run on the experimental clock rendered indistinguishable from
// one on the default.
//
// The other half is that it must say nothing when the file cannot back the
// claim. A truncated or hand-edited artifact putting "24 units per interval" on
// a report is worse than a report that is quiet about its clock.

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-run-timing-"));
const runs = path.join(sandbox, "runs");
process.env.SONATA_RUNS_DIR = runs;
process.chdir(sandbox);
mkdirSync(runs, { recursive: true });

const { readRun } = await import("../app/results/_lib/artifacts");

/** A minimal saved run: enough for the normaliser, plus whatever timing is on trial. */
function saved(runId: string, timing?: unknown): void {
  writeFileSync(
    path.join(runs, `${runId}.json`),
    JSON.stringify({
      runId,
      specId: "delivery-day",
      specTitle: "Delivery day",
      model: "fixture/model",
      status: "done",
      startedAt: 1000,
      endedAt: 2000,
      ticks: [],
      snapshots: {},
      verdict: null,
      ...(timing === undefined ? {} : { timing }),
    }),
    "utf8",
  );
}

it("keeps the recorded timing policy and refuses one the artifact cannot back", () => {
  saved("run_candidate", { policy: "provider-operations-v1", workUnitsPerTick: 24 });
  saved("run_default", { policy: "compressed-wall-time" });
  saved("run_historical");
  saved("run_corrupt", { policy: "provider-operations-v1", workUnitsPerTick: 0 });
  saved("run_invented", { policy: "one-minute-per-thought" });

  expect(readRun("run_candidate")?.timing).toEqual({ policy: "provider-operations-v1", workUnitsPerTick: 24 });
  expect(readRun("run_default")?.timing).toEqual({ policy: "compressed-wall-time" });
  // Absent, not defaulted: a run from before the experiment never declared a clock.
  expect(readRun("run_historical")?.timing).toBeUndefined();
  expect(readRun("run_corrupt")?.timing).toBeUndefined();
  expect(readRun("run_invented")?.timing).toBeUndefined();
});
