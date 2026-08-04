import {
  episodeTwins,
  plannedTicks,
  type AgentTrace,
  type BeatFired,
  type ByTwin,
  type DirectorEvent,
  type EpisodeRun,
  type EpisodeSpec,
  type TickRecord,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinHealth,
  type TwinName,
  type TwinSnapshot,
} from "@sonata/core";
import { createClock, type SimClock } from "./clock";
import {
  createRefRegistry,
  fireBeats,
  injectBody,
  scheduleBeats,
  summarizeBody,
  unreachableBeats,
  type RefRegistry,
} from "./beats";
import { auditRefName, createDirector, type Director } from "./director";
import { recentHistory, tickDigest } from "./timeline";
import { attributeActions, newTrace, traceCost, withTrace } from "./trace";
import { errorMessage } from "./http";
import { byTwin } from "./adapters";
import type { Agent, AgentContext } from "./agent";

// THE TICK LOOP.
//
// One simulated workday, one tick at a time, in an order that is not negotiable:
//
//   1. BEATS. What the day was always going to do, fired from the script.
//   2. DIRECTOR. What the world does back, having seen what the agent did in the
//      PREVIOUS tick (read out of each twin's audit log) and this tick's beats.
//   3. AGENT. Which then sees the results of both, and only ever as a digest.
//
// The order is what makes a run mean anything. If the agent went first it would
// act on a tick that had not happened yet; if the director ran after the agent
// inside the same tick, the world would answer an email in the same fifteen
// minutes it arrived, every time, and no episode could ever test patience.
//
// Everything time-shaped comes from `SimClock`, which is built once from the
// spec. `Date.now()` appears in this file only for wall-clock accounting — how
// long the run took, whether the budget guard has tripped — and never dates
// anything inside the world.

export interface RunOptions {
  spec: EpisodeSpec;
  adapters: TwinAdapter[];
  /** The agent under test. */
  agent: Agent;
  /** OpenRouter slug of the model under test, recorded on the artifact. */
  model: string;
  runId?: string;
  director?: Director;
  /** Reload the cast into each twin before tick 0. Off by default — see `seedViaApi`. */
  seedWorld?: boolean;
  /** Reset each twin to its pristine snapshot before seeding. Off by default. */
  resetTwins?: boolean;
  /** Story rows shown to the director each tick. */
  historyLimit?: number;
  /**
   * Whether every `must` criterion has passed, given the run so far.
   *
   * Injected rather than computed here: deciding it needs the checklist AND both
   * snapshots per twin (@sonata/judge's `runChecklist`), and taking a snapshot of
   * three twins every tick to answer it would cost more than the day it saves.
   * A caller that wants `stopWhenAllMustPass` supplies this; one that does not
   * gets the full day and a note saying so.
   */
  allMustPass?: (ticks: TickRecord[]) => boolean;
  /** Called after each tick, for a live dashboard. Never throws the run. */
  onTick?: (record: TickRecord) => void;
  /** Injected so an artifact's run id and tick timings are stable in tests. */
  now?: () => number;
}

export interface RunResult {
  run: EpisodeRun;
  trace: AgentTrace;
  /** Every twin's audit rows for the run, ascending — checklist input. */
  audit: TwinAuditRow[];
  /** Beat `ref` → what the twin minted for it. */
  refs: Record<string, string>;
  preflight: TwinHealth[];
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Every twin the spec's beats and criteria name, that we have an adapter for. */
export function adaptersForSpec(
  spec: EpisodeSpec,
  adapters: TwinAdapter[],
): ByTwin<TwinAdapter> {
  const wanted = new Set<TwinName>(episodeTwins(spec));
  return byTwin(adapters.filter((a) => wanted.has(a.name)));
}

/**
 * Authoring mistakes worth naming before a run rather than after one. Beats
 * outside the day never fire, and a beat for a twin with no adapter silently
 * records an error every time it comes round.
 */
export function specWarnings(spec: EpisodeSpec, used: ByTwin<TwinAdapter>): string[] {
  const notes: string[] = [];
  for (const beat of unreachableBeats(spec.beats, spec.clock.ticks)) {
    notes.push(`beat "${beat.id}" is scheduled for tick ${beat.tick}, outside the day`);
  }
  for (const twin of new Set(spec.beats.map((b) => b.twin))) {
    if (!used[twin]) notes.push(`no ${twin} adapter in this run, so its beats cannot land`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

interface TickDeps {
  spec: EpisodeSpec;
  clock: SimClock;
  used: ByTwin<TwinAdapter>;
  refs: RefRegistry;
  director: Director;
  agent: Agent;
  historyLimit: number;
  now: () => number;
}

/** Director events, injected in order, each recording what it created or why not. */
async function playEvents(
  events: DirectorEvent[],
  atISO: string,
  deps: TickDeps,
): Promise<DirectorEvent[]> {
  const played: DirectorEvent[] = [];
  const inject = { adapters: deps.used, world: deps.spec.world, refs: deps.refs };
  for (const event of events) {
    const outcome = await injectBody(event, atISO, inject);
    if (outcome.handle) deps.refs.record(event.id, outcome.handle);
    played.push({
      ...event,
      ...(outcome.handle ? { handle: outcome.handle } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  return played;
}

/** One line per beat still to come, so the director does not pre-empt the script. */
function upcomingLines(deps: TickDeps, after: number): string[] {
  return deps.spec.beats
    .filter((b) => b.tick > after && b.tick < deps.clock.ticks)
    .sort((a, b) => a.tick - b.tick)
    .map((b) => `${deps.clock.labelAt(b.tick)} — ${summarizeBody(b, deps.spec.world)}`);
}

export interface TickInput {
  tick: number;
  ticks: TickRecord[];
  /** Highest audit row id already attributed, per twin. */
  cursors: Map<TwinName, number>;
}

async function readDeltas(deps: TickDeps, cursors: Map<TwinName, number>): Promise<TwinAuditRow[]> {
  const rows: TwinAuditRow[] = [];
  for (const [name, adapter] of Object.entries(deps.used) as [TwinName, TwinAdapter][]) {
    try {
      const since = cursors.get(name) ?? 0;
      const fresh = await adapter.auditSince(since);
      for (const row of fresh) {
        rows.push(row);
        if (row.id > (cursors.get(name) ?? 0)) cursors.set(name, row.id);
      }
    } catch {
      // A twin that cannot be read is a twin the world hears nothing from this
      // tick. Failing the run over it would throw away the other two surfaces.
    }
  }
  return rows.sort((a, b) => a.id - b.id);
}

export async function runTick(deps: TickDeps, input: TickInput): Promise<TickRecord> {
  const { tick } = input;
  const startedAt = deps.now();
  const simTimeISO = deps.clock.isoAt(tick);
  const notes: string[] = [];

  // 1. Beats.
  const schedule = scheduleBeats(deps.spec.beats);
  const beatsFired: BeatFired[] = await fireBeats(schedule.at(tick), simTimeISO, {
    adapters: deps.used,
    world: deps.spec.world,
    refs: deps.refs,
  });

  // 2. Director. The deltas are what the agent did in the PREVIOUS tick — the
  // audit rows written since the last read — which is exactly what a coworker
  // would have seen by now.
  const deltas = await readDeltas(deps, input.cursors);
  // Offer the world a ref for each thing the agent just did, under the same name
  // the prompt hands the model, so a reply can attach to it.
  for (const row of deltas) {
    const name = auditRefName(row);
    if (name && row.targetId) deps.refs.record(name, { twin: row.twin, id: row.targetId });
  }

  const events = await deps.director.react({
    tick,
    simTimeISO,
    simTimeLabel: deps.clock.labelAt(tick),
    history: recentHistory(input.ticks, deps.historyLimit),
    deltas,
    beatsThisTick: beatsFired,
    upcoming: upcomingLines(deps, tick),
  });
  const directorEvents = await playEvents(events, simTimeISO, deps);
  const note = deps.director.lastNote();
  if (note) notes.push(note);

  // 3. Agent. Told that things arrived, never what they say.
  const ctx: AgentContext = {
    tick,
    simTimeISO,
    simTimeLabel: deps.clock.labelAt(tick),
    digest: tickDigest(beatsFired, directorEvents),
    ticksLeft: Math.max(0, deps.clock.last() - tick),
  };
  const agentSteps = await deps.agent.act(ctx);

  for (const beat of beatsFired) if (beat.error) notes.push(`beat ${beat.beatId}: ${beat.error}`);
  for (const event of directorEvents) if (event.error) notes.push(`event ${event.id}: ${event.error}`);

  return {
    tick,
    simTimeISO,
    startedAt,
    endedAt: deps.now(),
    beatsFired,
    directorEvents,
    agentSteps,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export interface StopState {
  ticks: TickRecord[];
  idle: number;
  elapsedMs: number;
  costUsd: number;
}

/**
 * Why the run should stop now, or undefined to carry on. Pure, because every one
 * of these is a billing decision and "why did that run stop at tick 9" has to be
 * answerable from the artifact alone.
 */
export function stopReason(spec: EpisodeSpec, state: StopState, allMustPass: boolean): string | undefined {
  const t = spec.termination;
  if (t.stopWhenAllMustPass && allMustPass) return "every must-pass criterion was met";
  if (state.idle >= t.idleTicks && t.idleTicks > 0) {
    return `the agent did nothing for ${state.idle} consecutive interval(s)`;
  }
  if (t.maxWallClockMs > 0 && state.elapsedMs >= t.maxWallClockMs) {
    return `the wall-clock budget of ${t.maxWallClockMs}ms ran out`;
  }
  if (t.maxCostUsd !== undefined && state.costUsd >= t.maxCostUsd) {
    return `the spend budget of $${t.maxCostUsd} ran out`;
  }
  return undefined;
}

/** True when the agent touched a tool this tick — an escalation counts as acting. */
export function didSomething(record: TickRecord): boolean {
  return record.agentSteps.some((s) => s.kind === "tool" || s.kind === "escalation");
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function snapshotAll(used: ByTwin<TwinAdapter>): Promise<ByTwin<TwinSnapshot>> {
  const out: ByTwin<TwinSnapshot> = {};
  for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
    try {
      out[name] = await adapter.snapshot();
    } catch {
      // A snapshot that could not be taken is a diff that cannot be drawn. The
      // judge handles a missing pair; a thrown run loses the whole day.
    }
  }
  return out;
}

export async function runEpisode(opts: RunOptions): Promise<RunResult> {
  const { spec } = opts;
  const now = opts.now ?? Date.now;
  const clock = createClock(spec.clock);
  const used = adaptersForSpec(spec, opts.adapters);
  const runId = opts.runId ?? `run-${spec.id}-${now()}`;
  const trace = newTrace(runId);
  const refs = createRefRegistry();
  const director = opts.director ?? createDirector({ spec });
  const startedAt = now();

  const run: EpisodeRun = {
    runId,
    specId: spec.id,
    specTitle: spec.title,
    model: opts.model,
    status: "running",
    startedAt,
    endedAt: null,
    ticks: [],
    snapshots: {},
    verdict: null,
  };

  const preflight: TwinHealth[] = [];
  for (const adapter of Object.values(used)) preflight.push(await adapter.health());

  const deps: TickDeps = {
    spec,
    clock,
    used,
    refs,
    director,
    agent: opts.agent,
    historyLimit: opts.historyLimit ?? 40,
    now,
  };

  const cursors = new Map<TwinName, number>();
  const allAudit: TwinAuditRow[] = [];
  const result = (): RunResult => ({
    run,
    trace,
    audit: [...allAudit].sort((a, b) => a.id - b.id),
    refs: Object.fromEntries(Object.entries(refs.entries()).map(([k, v]) => [k, v.id])),
    preflight,
  });

  try {
    if (opts.resetTwins) for (const adapter of Object.values(used)) await adapter.reset();
    if (opts.seedWorld) for (const adapter of Object.values(used)) await adapter.seed(spec);

    // The `before` snapshot is taken AFTER seeding: the diff has to show what the
    // agent changed, not what the seeder wrote.
    const before = await snapshotAll(used);

    // The audit cursor starts at whatever seeding left behind, so setup writes are
    // never read back as the agent's work.
    for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
      try {
        const existing = await adapter.auditSince(0);
        const last = existing[existing.length - 1];
        if (last) cursors.set(name, last.id);
      } catch {
        // Unreadable now means unreadable later; readDeltas reports it then.
      }
    }

    const warnings = specWarnings(spec, used);
    const total = Math.min(plannedTicks(spec), clock.ticks);
    let idle = 0;

    await withTrace(trace, async () => {
      for (let tick = 0; tick < total; tick++) {
        const record = await runTick(deps, { tick, ticks: run.ticks, cursors });
        // Authoring warnings ride on tick 0, which is the only tick a reader of
        // the artifact is guaranteed to look at.
        if (tick === 0) record.notes.unshift(...warnings);
        run.ticks.push(record);
        opts.onTick?.(record);

        idle = didSomething(record) ? 0 : idle + 1;
        const reason = stopReason(
          spec,
          {
            ticks: run.ticks,
            idle,
            elapsedMs: now() - startedAt,
            costUsd: traceCost(trace).usd,
          },
          opts.allMustPass?.(run.ticks) ?? false,
        );
        if (reason) {
          record.notes.push(`run stopped early: ${reason}`);
          break;
        }
      }

      await opts.agent.wrapUp();
    });

    const after = await snapshotAll(used);
    for (const name of Object.keys(used) as TwinName[]) {
      const pair = before[name];
      const post = after[name];
      if (pair && post) run.snapshots[name] = { before: pair, after: post };
    }

    // Attribution runs once, at the end, per twin: the pairing is ordinal within a
    // twin's log, so it needs the whole log and the whole trace.
    for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
      try {
        const rows = await adapter.auditSince(0);
        const from = cursorFloor(rows, run.ticks[0]?.startedAt ?? startedAt);
        allAudit.push(...from);
        attributeActions(trace, name, from);
      } catch {
        // Same reasoning as readDeltas: one silent twin, not a dead run.
      }
    }

    run.status = "done";
    run.endedAt = now();
    return result();
  } catch (err) {
    run.status = "failed";
    run.error = errorMessage(err);
    run.endedAt = now();
    return result();
  }
}

/**
 * Audit rows written from the moment the run began. Seeding and any earlier run
 * against the same twin sit below that line, and crediting them to this agent is
 * how a criterion passes for free.
 */
function cursorFloor(rows: TwinAuditRow[], startedAt: number): TwinAuditRow[] {
  return rows.filter((r) => r.ts >= startedAt).sort((a, b) => a.id - b.id);
}
