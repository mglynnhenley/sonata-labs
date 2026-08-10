"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, IconCopy, IconLayers, cn } from "@sonata/ui";
import { modelLabel } from "@/lib/models";
import {
  benchmarkMarkdown,
  CHECKLIST_LABEL,
  formatPercent,
  formatUsd,
  UNKNOWN,
  type Benchmark,
  type BenchmarkCell,
} from "../_lib/summary";
import { SIMULATED_HINT } from "../_lib/simulated";

// The article's table. Rows are models, columns are scenarios, cells are
// autonomy — and every cell is a link into the run that produced it, because a
// benchmark number nobody can open is a number nobody should believe.

/** Four steps, not a gradient: a legend with four entries is readable. */
function cellTone(value: number | null): string {
  if (value === null) return "bg-sn-surface text-sn-subtle";
  if (value >= 0.8) return "bg-sn-passed-soft text-sn-passed-ink";
  if (value >= 0.55) return "bg-sn-gold-soft text-sn-gold-ink";
  if (value >= 0.3) return "bg-sn-warning-soft text-sn-warning-ink";
  return "bg-sn-failed-soft text-sn-failed-ink";
}

export function BenchmarkTable({ benchmark }: { benchmark: Benchmark }) {
  const [copied, setCopied] = useState(false);

  if (benchmark.rows.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size={20} />}
        title="The table needs scored runs"
        description="Run the same scenario on two or more models and this becomes the comparison the article prints: autonomy per scenario, mean autonomy, the failure mode each model repeats, and what an episode costs."
        hints={[
          "Rows are models, columns are scenarios",
          "Every cell opens the run behind it",
          "Copy it as Markdown straight into the draft",
          // The empty state returns before the footnotes below, and "no runs
          // yet" over a directory full of fabricated ones is the same silence
          // this whole pass is undoing.
          ...(benchmark.simulated > 0
            ? [
                `${benchmark.simulated} saved run${benchmark.simulated === 1 ? "" : "s"} cannot fill this table: ${SIMULATED_HINT.toLowerCase()}`,
              ]
            : []),
        ]}
      />
    );
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(benchmarkMarkdown(benchmark));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false); // clipboard blocked — the table is still on screen
    }
  }

  return (
    <Card padding="none" radius="2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sn-line px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-medium text-sn-ink">Autonomy by model and scenario</h3>
          <p className="mt-0.5 text-[12px] text-sn-muted">
            Mean autonomy across every run of that pairing that played its day to the end. Click
            a cell to open the run.
          </p>
        </div>
        <Button size="sm" icon={<IconCopy size={13} />} onClick={copyMarkdown}>
          {copied ? "Copied" : "Copy as Markdown"}
        </Button>
      </div>

      <div className="sn-scroll overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">Autonomy by model and scenario</caption>
          <thead className="border-b border-sn-line">
            <tr>
              <th
                scope="col"
                className="px-4 py-2.5 text-left text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase"
              >
                Model
              </th>
              {benchmark.scenarios.map((scenario) => (
                <th
                  key={scenario.specId}
                  scope="col"
                  className="px-3 py-2.5 text-center text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase"
                >
                  {scenario.title}
                </th>
              ))}
              <th
                scope="col"
                className="px-3 py-2.5 text-right text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase"
              >
                Mean autonomy
              </th>
              <th
                scope="col"
                className="px-3 py-2.5 text-left text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase"
              >
                Most common failure
              </th>
              <th
                scope="col"
                className="px-4 py-2.5 text-right text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase"
              >
                Cost / episode
              </th>
            </tr>
          </thead>
          <tbody>
            {benchmark.rows.map((row) => (
              <tr key={row.model} className="border-b border-sn-line/70 last:border-b-0">
                {/* Label above, slug below: the article reads the first and
                    reproduces from the second. */}
                <th scope="row" className="px-4 py-2.5 text-left align-middle font-normal">
                  <span className="block text-[13px] font-medium text-sn-ink">
                    {modelLabel(row.model)}
                    <span className="ml-2 text-[11px] font-normal text-sn-subtle">
                      {row.runs} run{row.runs === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-sn-subtle">
                    {row.model}
                  </span>
                </th>
                {benchmark.scenarios.map((scenario) => (
                  <td key={scenario.specId} className="px-3 py-2 text-center align-middle">
                    <Cell cell={row.cells[scenario.specId]} />
                  </td>
                ))}
                <td
                  data-numeric
                  className="px-3 py-2.5 text-right align-middle text-[14px] font-medium text-sn-ink"
                >
                  {formatPercent(row.meanAutonomy)}
                </td>
                <td className="px-3 py-2.5 text-left align-middle text-[12px] text-sn-muted">
                  {row.topFailure ? (
                    <>
                      {row.topFailure.label}
                      <span className="text-sn-subtle"> ×{row.topFailure.count}</span>
                    </>
                  ) : (
                    <span className="text-sn-subtle">none found</span>
                  )}
                </td>
                <td
                  data-numeric
                  className="px-4 py-2.5 text-right align-middle text-[12px] text-sn-muted"
                >
                  {formatUsd(row.costPerEpisode)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Said out loud, because a mean over a quietly smaller population is the
          same lie as a mean over a padded one. */}
      {benchmark.excluded > benchmark.simulated ? (
        <p className="border-t border-sn-line px-5 py-2.5 text-[11.5px] text-sn-muted">
          {benchmark.excluded - benchmark.simulated} run
          {benchmark.excluded - benchmark.simulated === 1 ? "" : "s"} never finished the day and{" "}
          {benchmark.excluded - benchmark.simulated === 1 ? "is" : "are"} not averaged here — a run
          that stopped before it acted has no autonomy to report. They are all still in the Runs
          list.
        </p>
      ) : null}

      {/* Its own paragraph, above nothing and under everything: this table was
          for months a comparison of models that were never called, and a reader
          who has seen it before is owed that in the product rather than in a
          changelog. */}
      {benchmark.simulated > 0 ? (
        <p className="border-t border-sn-line px-5 py-2.5 text-[11.5px] text-sn-muted">
          <span className="font-medium text-sn-ink">
            {benchmark.simulated} simulated run{benchmark.simulated === 1 ? "" : "s"}{" "}
            {benchmark.simulated === 1 ? "is" : "are"} left out entirely.
          </span>{" "}
          {SIMULATED_HINT} Until this was found they were averaged into this table as if they
          were measurements. They are still in the Runs list, marked;{" "}
          <code className="font-mono text-[11px]">sonata prune --simulated</code> removes them for
          good.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 border-t border-sn-line px-5 py-3 text-[11px] text-sn-subtle">
        <span>Autonomy — how much of the job got done without a human stepping in.</span>
        <span className="flex items-center gap-1.5">
          <Swatch className="bg-sn-failed-soft" /> under 30%
          <Swatch className="ml-2 bg-sn-warning-soft" /> 30–55%
          <Swatch className="ml-2 bg-sn-gold-soft" /> 55–80%
          <Swatch className="ml-2 bg-sn-passed-soft" /> 80%+
        </span>
      </div>
    </Card>
  );
}

function Swatch({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-2.5 w-2.5 rounded-full border border-sn-line", className)}
    />
  );
}

function Cell({ cell }: { cell: BenchmarkCell | undefined }) {
  if (!cell || !cell.latestRunId) {
    return (
      <span className="inline-flex h-9 w-full min-w-[74px] items-center justify-center rounded-sn-md border border-dashed border-sn-line text-[12px] text-sn-subtle">
        {UNKNOWN}
      </span>
    );
  }

  // One run: straight to it. Several: to the latest of them — the mean's most
  // recent witness — until the run list grows per-cell filters.
  const href = `/runs/${cell.latestRunId}`;

  return (
    <Link
      href={href}
      title={`${cell.runs} run${cell.runs === 1 ? "" : "s"} · ${CHECKLIST_LABEL.toLowerCase()} ${formatPercent(cell.score)} · ${formatUsd(cell.costUsd)}`}
      className={cn(
        "inline-flex h-9 w-full min-w-[74px] flex-col items-center justify-center rounded-sn-md border border-transparent",
        "transition-[border-color,box-shadow] duration-150 ease-sn hover:border-sn-line-strong hover:shadow-sn-xs",
        cellTone(cell.autonomy),
      )}
    >
      <span data-numeric className="text-[14px] font-medium leading-none">
        {formatPercent(cell.autonomy)}
      </span>
      {cell.runs > 1 ? (
        <span className="mt-0.5 text-[10px] leading-none opacity-70">n={cell.runs}</span>
      ) : null}
    </Link>
  );
}
