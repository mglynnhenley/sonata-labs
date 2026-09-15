import { episodeTwins, plannedTicks, type EpisodeSpec } from "@sonata/core";
import { SCENARIOS } from "@sonata/scenarios";
import type { EpisodeSummary } from "../../api/_lib/types";

// A shipped scenario, described the way a saved one is.
//
// A shipped day only becomes a record the first time something resolves it, and
// until then it was invisible: the catalogue and the run panel both list saved
// episodes, so a fresh install showed whichever days this machine happened to
// have run before. Seven of the thirteen were unreachable without knowing an id,
// including both continuity weeks.
//
// Registration still happens on first run, where it belongs — this only stops a
// scenario being unreachable before it has ever been reached.

/** Shipped scenarios nobody has registered yet, as summaries the UI can render. */
export function unregisteredShipped(registeredIds: Iterable<string>): EpisodeSummary[] {
  const known = new Set(registeredIds);
  return SCENARIOS.filter((spec) => !known.has(spec.id)).map(summarize);
}

export function summarize(spec: EpisodeSpec): EpisodeSummary {
  return {
    id: spec.id,
    title: spec.title,
    story: spec.story,
    task: spec.task,
    // No world record exists yet, so the card names the business from the spec
    // rather than linking an environment that has not been written.
    worldId: "",
    worldName: spec.world.business.name,
    templateId: null,
    twins: episodeTwins(spec),
    counts: { beats: spec.beats.length, criteria: spec.success.checklist.length, ticks: plannedTicks(spec) },
    createdAt: 0,
    lastRun: null,
  };
}
