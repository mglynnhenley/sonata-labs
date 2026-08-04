import type { Beat, EpisodeSpec } from "./types/episode";
import { TWIN_NAMES, type TwinName } from "./types/world";

// Small pure reads over an EpisodeSpec. The engine and the dashboard both need
// these, and both getting them slightly differently is how a scenario ends up
// listed as "Gmail only" while it quietly moves a meeting.

/** Beats scheduled for a tick, in author order — the order they must fire in. */
export function beatsAt(beats: Beat[], tick: number): Beat[] {
  return beats.filter((b) => b.tick === tick);
}

/**
 * Which twins this episode actually needs, derived rather than declared: beats
 * and criteria are the truth, and a hand-maintained list of surfaces goes stale
 * the first time someone adds a calendar beat to a mail episode.
 */
export function episodeTwins(spec: EpisodeSpec): TwinName[] {
  const used = new Set<TwinName>();
  for (const b of spec.beats) used.add(b.twin);
  for (const c of spec.success.checklist) if (c.twin !== "any") used.add(c.twin);
  return TWIN_NAMES.filter((t) => used.has(t));
}

/**
 * How many ticks this run may last: the day, capped by the spec's own guard.
 * `termination.maxTicks` can only shorten a day, never extend it — the clock
 * owns the length.
 */
export function plannedTicks(spec: EpisodeSpec): number {
  const cap = spec.termination.maxTicks;
  return cap === undefined ? spec.clock.ticks : Math.min(spec.clock.ticks, Math.max(0, cap));
}

/**
 * Beat refs that nothing creates but something points at — a broken spec, caught
 * before a run rather than as a silent no-op three hours into a benchmark.
 */
export function danglingRefs(spec: EpisodeSpec): string[] {
  const defined = new Set(spec.beats.map((b) => b.ref).filter((r): r is string => !!r));
  const wanted: string[] = [];

  for (const b of spec.beats) {
    if (b.twin === "gmail" && b.payload.inReplyTo) wanted.push(b.payload.inReplyTo);
    if (b.twin === "slack" && b.kind === "message" && b.payload.threadRef) {
      wanted.push(b.payload.threadRef);
    }
    if (b.twin === "slack" && b.kind === "reaction") wanted.push(b.payload.messageRef);
    if (b.twin === "calendar" && b.kind !== "invite") wanted.push(b.payload.eventRef);
  }
  for (const c of spec.success.checklist) if (c.ref) wanted.push(c.ref);

  return [...new Set(wanted.filter((r) => !defined.has(r)))];
}
