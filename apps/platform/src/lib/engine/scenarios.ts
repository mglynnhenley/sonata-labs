import { plannedTicks, type EpisodeSpec } from "@sonata/core";
import { SCENARIOS, getScenario } from "@sonata/scenarios";
import type { GeneratedWorld } from "@sonata/world";
import { actualCounts, growBacklog } from "./clone";
import { plannedCounts } from "../../../app/api/_lib/authored";
import { draftScenario } from "../../../app/api/_lib/draft";
import {
  getEpisode,
  listEpisodes,
  listWorlds,
  saveEpisode,
  saveWorld,
} from "../../../app/api/_lib/records";
import { assembleTemplate, getTemplate, templateSummaries } from "../../../app/api/_lib/templates";
import type { EpisodeRecord, EpisodeSummary, WorldRecord } from "../../../app/api/_lib/types";

// Finding and making scenarios, through the dashboard's own store.
//
// The CLI and the dashboard resolve a scenario with the same function on
// purpose: `sonata run <id>` and pressing Start on the Runs page must be able to
// disagree about nothing.
//
// Two sources, one record. A scenario is usually something the user made — a
// template card, the new-scenario composer, `sonata world create` — and those
// live in the store. The five hand-written days in @sonata/scenarios are the
// benchmark's suite and ship with the product, so they are registered into that
// same store the first time one is asked for, rather than being a second kind of
// scenario the runs list, the results page and the benchmark each have to know
// about.

/** What `sonata world create` produced: a cloned business and its first day. */
export interface CreatedScenario {
  world: WorldRecord;
  episode: EpisodeRecord;
  /** True when the day was assembled from a template because no model answered. */
  offline: boolean;
  /** Why, when `offline` — the model's own error, verbatim. */
  offlineReason?: string;
  /** Set when the day was written but its backlog was not, and why. */
  backlogReason?: string;
}

/**
 * Register a shipped day into the store, so it is a scenario like any other.
 *
 * Its world is reused when one with the same business is already there: two of
 * the five are set in the same company, and cloning Northwind twice would put
 * two identical businesses on the Scenarios page for no reason.
 */
function registerShipped(spec: EpisodeSpec): EpisodeRecord {
  const existing = listWorlds().find((w) => w.name === spec.world.business.name);
  const world =
    existing ??
    saveWorld(
      spec.world,
      spec.world.business.description,
      plannedCounts(spec.world, spec.beats),
    );
  return saveEpisode(spec, { id: world.id, name: world.name }, null);
}

/** A saved scenario, or a shipped one that has not been registered yet. */
type Found = { record: EpisodeRecord } | { spec: EpisodeSpec };

/**
 * What a human typed, matched against both sources: an id, or enough of a title
 * to be unambiguous. Titles are matched because ids are generated
 * (`ep_lq3f8k_7a2c`) and nobody types those from memory.
 *
 * Read-only, so planning a benchmark can ask what a scenario is without
 * registering five worlds nobody asked for.
 */
function find(query: string): Found {
  const wanted = query.trim();
  if (!wanted) throw new Error("Say which scenario to run.");

  const exact = getEpisode(wanted);
  if (exact) return { record: exact };

  const shippedById = getScenario(wanted);
  if (shippedById) return { spec: shippedById };

  const lower = wanted.toLowerCase();
  const candidates = [
    ...listEpisodes().map((e) => ({ id: e.id, title: e.title, shipped: false })),
    // Only the ones not already registered, or a match would be offered twice.
    ...SCENARIOS.filter((s) => !getEpisode(s.id)).map((s) => ({
      id: s.id,
      title: s.title,
      shipped: true,
    })),
  ];
  const matches = candidates.filter((c) => c.title.toLowerCase().includes(lower));

  if (matches.length === 1) {
    const found = matches[0];
    const saved = found.shipped ? undefined : getEpisode(found.id);
    if (saved) return { record: saved };
    const spec = getScenario(found.id);
    if (spec) return { spec };
  }
  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} scenarios:\n` +
        matches.map((m) => `  ${m.id}  ${m.title}`).join("\n"),
    );
  }
  throw new Error(
    `No scenario matches "${wanted}". These exist:\n` +
      candidates.map((m) => `  ${m.id}  ${m.title}`).join("\n"),
  );
}

/**
 * The scenario to run, registered into the store if it was a shipped one. Every
 * run goes through here, so a run always points at a scenario the results page
 * can open.
 */
export function resolveScenario(query: string): EpisodeRecord {
  const found = find(query);
  return "record" in found ? found.record : registerShipped(found.spec);
}

/** Enough to plan and price a matrix, without writing anything down. */
export interface ScenarioBrief {
  id: string;
  title: string;
  ticks: number;
}

export function describeScenario(query: string): ScenarioBrief {
  const found = find(query);
  return "record" in found
    ? { id: found.record.id, title: found.record.title, ticks: found.record.counts.ticks }
    : { id: found.spec.id, title: found.spec.title, ticks: plannedTicks(found.spec) };
}

/** Saved scenarios only — what the user has made. */
export function listScenarios(): EpisodeSummary[] {
  return listEpisodes();
}

/** The five hand-written days that ship with the product: id and title. */
export function listShipped(): Array<{ id: string; title: string; story: string }> {
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title, story: s.story }));
}

/** Ids of the shipped suite, in run order — the benchmark's default columns. */
export function shippedIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}

export function listTemplates(): ReturnType<typeof templateSummaries> {
  return templateSummaries();
}

/**
 * Clone a business from one sentence and save its first day.
 *
 * This is POST /api/episodes with a `brief`, called directly rather than over
 * HTTP: the CLI must work with no dashboard running, and going through the route
 * would make the terminal depend on a server being up to do something entirely
 * local.
 */
export async function createWorldFromBrief(
  brief: string,
  ticks: number,
  say: (msg: string) => void = () => {},
): Promise<CreatedScenario> {
  const drafted = await draftScenario(brief, ticks);

  // The backlog: the days already behind this one. A second pass rather than
  // part of the first, because the day has to exist before its past can be
  // written to fit it — and because a clone with no backlog is an empty inbox
  // with a cast list attached, which is not a business anyone can test against.
  let clone: GeneratedWorld | undefined;
  let backlogReason: string | undefined;
  if (!drafted.draft.offline) {
    try {
      say("writing the days behind this one, across all three surfaces");
      clone = await growBacklog(drafted.spec, brief);
    } catch (err) {
      // A day with no history is still a runnable day. Say so rather than let a
      // user believe an empty inbox is what their business looks like.
      backlogReason = err instanceof Error ? err.message : String(err);
    }
  }

  // The clone's world is the authority once there is one: `canonicalize`
  // re-derives channel membership from the Slack backlog, so saving the
  // pre-clone seed would leave the world and the twins disagreeing about #ops.
  const seed = clone?.world ?? drafted.seed;
  const spec = clone ? { ...drafted.spec, world: seed } : drafted.spec;
  const counts = clone ? actualCounts(clone) : drafted.draft.counts;

  const world = saveWorld(seed, brief, counts, clone);
  const episode = saveEpisode(spec, world, null);
  return {
    world,
    episode,
    offline: drafted.draft.offline,
    ...(drafted.draft.offlineReason ? { offlineReason: drafted.draft.offlineReason } : {}),
    ...(backlogReason ? { backlogReason } : {}),
  };
}

/** Clone the business behind a shipped template, skipping the model call. */
export function createWorldFromTemplate(templateId: string): CreatedScenario {
  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(
      `No template called "${templateId}". Shipped templates:\n` +
        templateSummaries()
          .map((t) => `  ${t.id}  ${t.title}`)
          .join("\n"),
    );
  }
  const { seed, spec } = assembleTemplate(template);
  const world = saveWorld(seed, template.description, plannedCounts(seed, spec.beats));
  const episode = saveEpisode(spec, world, template.id);
  return { world, episode, offline: true };
}

/**
 * The day as it will actually be run: the saved spec with the requested length.
 *
 * `ticks` shortens the clock rather than the termination guard, because the
 * clock owns the length of the day — a spec run at 12 ticks has to date its
 * beats and its digest against a 12-tick day, not a 32-tick one it will leave
 * early.
 */
export function specForRun(spec: EpisodeSpec, ticks?: number): EpisodeSpec {
  if (ticks === undefined) return spec;
  const wanted = Math.max(1, Math.min(Math.round(ticks), 200));
  if (wanted === spec.clock.ticks) return spec;
  return { ...spec, clock: { ...spec.clock, ticks: wanted } };
}
