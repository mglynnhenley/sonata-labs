import type {
  AgentStep,
  BeatFired,
  DirectorEvent,
  EpisodeRun,
  TickRecord,
  TwinName,
} from "@sonata/core";

// The day, flattened into one ordered list. `TickRecord` keeps beats, agent steps
// and director events in separate arrays because they are produced by different
// parts of the engine; the replay has to tell one story, so it interleaves them
// here — once, purely — and everything downstream indexes into the same array.
//
// Within a tick the order is: what the world did to the agent, what the agent did
// about it, then what the world did back. That is the causal order of a tick, and
// it is what makes `becauseSeq` read as an answer rather than a coincidence.

export type MomentSource = "world" | "agent" | "director" | "engine";

export interface Moment {
  /** Position in the replay. The selection is this number. */
  index: number;
  tick: number;
  simTimeISO: string;
  source: MomentSource;
  twin: TwinName | null;
  title: string;
  /** One quiet line under the title. */
  detail?: string;
  /** `AgentStep.seq`, when this is an agent step — the judge points at these. */
  seq?: number;
  /** Deep link into the twin's own UI. */
  url?: string;
  error?: string;
  isMutation: boolean;
  step?: AgentStep;
  beat?: BeatFired;
  event?: DirectorEvent;
  note?: string;
}

function ticksOf(run: EpisodeRun): TickRecord[] {
  return Array.isArray(run.ticks) ? run.ticks : [];
}

function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** "gmail · email" reads as noise; the twin chip already says gmail. */
function beatTitle(beat: BeatFired): string {
  return beat.summary?.trim() || `${beat.kind} fired`;
}

function stepTitle(step: AgentStep): string {
  if (step.kind === "tool") return step.name;
  if (step.kind === "escalation") return "Handed the job back to a human";
  return "Thinking";
}

function stepDetail(step: AgentStep): string | undefined {
  if (step.kind === "tool") return step.error ? `Failed: ${step.error}` : step.resultSummary;
  return step.text?.trim() || undefined;
}

/**
 * @param people `Person.id` → name, from the run's cast. Optional because an
 *   artifact written without its spec still has to replay; an unresolved id is
 *   shown as-is rather than blanked.
 */
export function buildMoments(run: EpisodeRun, people: Record<string, string> = {}): Moment[] {
  const moments: Moment[] = [];
  let index = 0;

  const push = (moment: Omit<Moment, "index">) => {
    moments.push({ ...moment, index: index++ });
  };

  for (const tick of ticksOf(run)) {
    const at = { tick: tick.tick ?? 0, simTimeISO: tick.simTimeISO ?? "" };

    for (const beat of arr<BeatFired>(tick.beatsFired)) {
      push({
        ...at,
        source: "world",
        twin: beat.twin ?? null,
        title: beatTitle(beat),
        detail: beat.error ? `Could not be delivered: ${beat.error}` : undefined,
        ...(beat.handle?.url ? { url: beat.handle.url } : {}),
        ...(beat.error ? { error: beat.error } : {}),
        isMutation: false,
        beat,
      });
    }

    // Sorted, not trusted: the engine appends in order, but a resumed run can
    // interleave, and a replay whose steps run backwards is worse than useless.
    const steps = arr<AgentStep>(tick.agentSteps).slice().sort((a, b) => a.seq - b.seq);
    for (const step of steps) {
      const detail = stepDetail(step);
      push({
        ...at,
        source: "agent",
        twin: step.kind === "tool" ? (step.twin ?? null) : null,
        title: stepTitle(step),
        ...(detail ? { detail } : {}),
        seq: step.seq,
        ...(step.kind === "tool" && step.error ? { error: step.error } : {}),
        isMutation: step.kind === "tool" && step.isMutation,
        step,
      });
    }

    for (const event of arr<DirectorEvent>(tick.directorEvents)) {
      push({
        ...at,
        source: "director",
        twin: event.twin ?? null,
        title: `${people[event.personId] ?? event.personId} answered`,
        ...(event.reason ? { detail: event.reason } : {}),
        ...(event.handle?.url ? { url: event.handle.url } : {}),
        ...(event.error ? { error: event.error } : {}),
        isMutation: false,
        event,
      });
    }

    for (const note of arr<string>(tick.notes)) {
      push({ ...at, source: "engine", twin: null, title: note, isMutation: false, note });
    }
  }

  return moments;
}

/**
 * Where a finding points. A judge names steps by `seq` and reads a projection of
 * the trace, so a seq can name a step this artifact does not contain (an old
 * report, a re-judge after a rewrite) — fall back to the tick, then give up
 * rather than jumping somewhere arbitrary and calling it evidence.
 */
export function findMomentIndex(
  moments: Moment[],
  target: { seq?: number[]; tick?: number },
): number {
  for (const seq of target.seq ?? []) {
    const hit = moments.findIndex((m) => m.seq === seq);
    if (hit >= 0) return hit;
  }
  if (target.tick !== undefined) {
    const hit = moments.findIndex((m) => m.tick === target.tick);
    if (hit >= 0) return hit;
  }
  return -1;
}

export interface ReplayStats {
  ticks: number;
  toolCalls: number;
  mutations: number;
  escalations: number;
  beats: number;
  directorEvents: number;
}

export function replayStats(moments: Moment[]): ReplayStats {
  const ticks = new Set(moments.map((m) => m.tick));
  return {
    ticks: ticks.size,
    toolCalls: moments.filter((m) => m.step?.kind === "tool").length,
    mutations: moments.filter((m) => m.isMutation).length,
    escalations: moments.filter((m) => m.step?.kind === "escalation").length,
    beats: moments.filter((m) => m.source === "world").length,
    directorEvents: moments.filter((m) => m.source === "director").length,
  };
}
