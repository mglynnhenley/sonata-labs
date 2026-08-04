import {
  resolvePerson,
  type Beat,
  type BeatBody,
  type BeatFired,
  type ByTwin,
  type InjectedRef,
  type TwinAdapter,
  type WorldSeed,
} from "@sonata/core";
import { errorMessage } from "./http";

// The script. Beats are everything the day does on its own — the angry client at
// 09:15, the escalation in #ops at 11:00 — fixed in advance so that two models
// run against the same day and the comparison means something. Everything
// reactive comes from the director instead.
//
// A beat and a director event carry the same (twin, kind, payload) triple, so
// both are injected by `injectBody` below. The only difference is who wrote it.

/** Beats indexed by the tick they fire on, in author order within a tick. */
export interface BeatSchedule {
  at(tick: number): Beat[];
  /** Ticks that have at least one beat, ascending. */
  ticks(): number[];
  readonly count: number;
}

export function scheduleBeats(beats: Beat[]): BeatSchedule {
  const byTick = new Map<number, Beat[]>();
  for (const beat of beats) {
    const list = byTick.get(beat.tick);
    // Push rather than sort: author order within a tick is meaningful (the email
    // that starts a thread must land before the reply that answers it), and the
    // spec's array order is the only record of it.
    if (list) list.push(beat);
    else byTick.set(beat.tick, [beat]);
  }
  return {
    at: (tick) => byTick.get(tick) ?? [],
    ticks: () => [...byTick.keys()].sort((a, b) => a - b),
    count: beats.length,
  };
}

/** Beats scheduled outside the day — authoring mistakes that would never fire. */
export function unreachableBeats(beats: Beat[], ticks: number): Beat[] {
  return beats.filter((b) => !Number.isInteger(b.tick) || b.tick < 0 || b.tick >= ticks);
}

// ---------------------------------------------------------------------------
// Refs. A beat names what it creates ("the escalation email"); later beats,
// director events and success criteria point at that name. The registry is what
// turns the name into the id the twin actually minted.
// ---------------------------------------------------------------------------

export interface RefRegistry {
  record(ref: string | undefined, handle: InjectedRef): void;
  resolve(ref: string): InjectedRef | undefined;
  /** Everything resolved so far — carried into the artifact for the checkers. */
  entries(): Record<string, InjectedRef>;
}

export function createRefRegistry(initial: Record<string, InjectedRef> = {}): RefRegistry {
  const map = new Map<string, InjectedRef>(Object.entries(initial));
  return {
    record(ref, handle) {
      // First writer wins: a ref names one artefact, and a second beat quietly
      // rebinding it would silently redirect every criterion pointing at it.
      if (ref && !map.has(ref)) map.set(ref, handle);
    },
    resolve: (ref) => map.get(ref),
    entries: () => Object.fromEntries(map),
  };
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export interface InjectDeps {
  adapters: ByTwin<TwinAdapter>;
  world: WorldSeed;
  refs: RefRegistry;
}

function nameOf(world: WorldSeed, ref: string): string {
  return resolvePerson(world, ref)?.name ?? ref;
}

/**
 * One line for the timeline: "Dana Reyes emailed about the missed SLA". Written
 * from the world's point of view, because this is what the run view shows a
 * human and what the agent's tick digest is built from.
 */
export function summarizeBody(body: BeatBody, world: WorldSeed): string {
  switch (body.kind) {
    case "email": {
      const to = body.payload.to.map((r) => nameOf(world, r)).join(", ");
      return `${nameOf(world, body.payload.from)} emailed ${to}: "${body.payload.subject}"`;
    }
    case "message": {
      const where = body.payload.channel.startsWith("#")
        ? body.payload.channel
        : `#${body.payload.channel}`;
      return `${nameOf(world, body.payload.from)} posted in ${where}: "${body.payload.text}"`;
    }
    case "reaction":
      return `${nameOf(world, body.payload.from)} reacted :${body.payload.emoji}:`;
    case "invite":
      return (
        `${nameOf(world, body.payload.organizer)} invited ` +
        `${body.payload.attendees.map((a) => nameOf(world, a)).join(", ")} to ` +
        `"${body.payload.title}" at ${body.payload.startISO}`
      );
    case "move":
      return `"${body.payload.eventRef}" moved to ${body.payload.startISO}${
        body.payload.reason ? ` (${body.payload.reason})` : ""
      }`;
    case "cancel":
      return `"${body.payload.eventRef}" cancelled${
        body.payload.reason ? ` (${body.payload.reason})` : ""
      }`;
    case "rsvp":
      return `${nameOf(world, body.payload.who)} ${body.payload.response} "${body.payload.eventRef}"`;
  }
}

export interface InjectOutcome {
  handle?: InjectedRef;
  error?: string;
}

/**
 * Play one body into its twin.
 *
 * Never throws. A twin that 500s, a route that does not exist yet, a beat
 * pointing at a ref nothing created — all of it becomes a recorded error on that
 * one beat. A run that dies at 11:00 because one injection failed teaches nothing
 * about the agent; a run where the timeline says "this did not happen, here is
 * why" teaches everything.
 */
export async function injectBody(
  body: BeatBody,
  atISO: string,
  deps: InjectDeps,
): Promise<InjectOutcome> {
  const adapter = deps.adapters[body.twin];
  if (!adapter) return { error: `no ${body.twin} adapter in this run` };
  try {
    const handle = await adapter.inject(body, {
      atISO,
      resolve: (ref) => deps.refs.resolve(ref),
      world: deps.world,
    });
    return { handle };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Fire this tick's beats, in order, recording what each one created. */
export async function fireBeats(
  beats: Beat[],
  atISO: string,
  deps: InjectDeps,
): Promise<BeatFired[]> {
  const fired: BeatFired[] = [];
  for (const beat of beats) {
    // Sequential on purpose: a beat may reply into the thread the previous beat
    // just created, and the ref registry only knows about it once it has landed.
    const outcome = await injectBody(beat, atISO, deps);
    if (outcome.handle) deps.refs.record(beat.ref, outcome.handle);
    fired.push({
      beatId: beat.id,
      ...(beat.ref ? { ref: beat.ref } : {}),
      twin: beat.twin,
      kind: beat.kind,
      ...(outcome.handle ? { handle: outcome.handle } : {}),
      summary: summarizeBody(beat, deps.world),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  return fired;
}
