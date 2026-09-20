import type { EpisodeSpec } from "@sonata/core";
import { readBrief, readRun, readSpec, readTrace, type RunBrief, type SavedRun } from "./artifacts";
import { costBreakdown, type CostReport } from "./cost";
import { buildRunReport } from "./report";
import { endOfDay, endStateMarkdown, hasEndState } from "../_components/endstate";
import { harnessMarkdown, harnessReport, hasFaults, specDescribes, withFindings } from "../_components/harness";
import { getEpisode } from "../../api/_lib/records";

/** One document for the GUI, copy button and download. Evidence warnings must
 * survive exporting just as the assessment does. */
export function assembleRunDocument(input: {
  run: SavedRun;
  brief: RunBrief;
  /** The version embedded when this run began, never today's editable scenario. */
  spec: EpisodeSpec | null;
  cost?: CostReport;
}): string {
  const { run, brief, spec, cost } = input;
  const { report, judge } = harnessReport({
    run, spec, capture: run.evidence, offsetMinutes: brief.offsetMinutes,
  });
  let markdown = buildRunReport(withFindings(run, judge), brief, cost, spec);
  const closing = endOfDay({
    snapshots: run.snapshots,
    ticks: run.ticks,
    cast: spec?.world.cast ?? [],
    evidence: run.evidence.twins,
    offsetMinutes: brief.offsetMinutes,
    judge,
  });
  if (hasEndState(closing)) {
    const heading = "\n## How it worked the day";
    const at = markdown.indexOf(heading);
    const next = at < 0 ? -1 : markdown.indexOf("\n## ", at + heading.length);
    const section = endStateMarkdown(closing);
    markdown = next < 0
      ? `${markdown}\n${section}\n`
      : `${markdown.slice(0, next + 1)}${section}\n\n${markdown.slice(next + 1)}`;
  }
  if (hasFaults(report)) {
    const at = markdown.indexOf("\n## ");
    const section = harnessMarkdown(report);
    markdown = at < 0
      ? `${markdown}\n${section}\n`
      : `${markdown.slice(0, at + 1)}${section}\n\n${markdown.slice(at + 1)}`;
  }
  return markdown;
}

/** Read-only. Loading a report never resumes a run or consults current app data. */
/** The scenario as written, when it still matches what ran; otherwise what ran. */
function scheduledSpec(runId: string, run: SavedRun): EpisodeSpec | null {
  const scenario = getEpisode(run.specId)?.spec ?? null;
  return scenario && specDescribes(run, scenario) ? scenario : readSpec(runId);
}

export function loadRunDocument(runId: string): { run: SavedRun; markdown: string } | null {
  const run = readRun(runId);
  if (!run) return null;
  return {
    run,
    markdown: assembleRunDocument({
      run,
      brief: readBrief(runId),
      spec: scheduledSpec(runId, run),
      cost: costBreakdown(readTrace(runId), run.verdict?.cost ?? null),
    }),
  };
}
