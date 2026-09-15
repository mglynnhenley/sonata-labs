import { bodyObservation, observeActions } from "./observations";
import {
  normalizeSessionTiming,
  owner,
  plannedTicks,
  type AgentStep,
  type AgentTrace,
  type BeatFired,
  type ByTwin,
  type Clock,
  type DirectorEvent,
  type EpisodeRun,
  type EpisodeSpec,
  type RunStatus,
  type SessionActionRecord,
  type SessionTimingPolicy,
  type TickRecord,
  type TimelineEntry,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinHealth,
  type TwinName,
  type TwinSnapshot,
} from "@sonata/core";
import { createClock, type SimClock } from "./clock";
import {
  adaptBeats,
  createRefRegistry,
  fireBeats,
  injectBody,
  scheduleBeats,
  type RefRegistry,
} from "./beats";
import {
  auditRefName,
  createDirector,
  type DeltaDetail,
  type Director,
} from "./director";
import { colleagueHistory, runTimeline } from "./timeline";
import { auditKey, newTrace, withTrace } from "./trace";
import { adaptersForSpec, didSomething, specWarnings, type RunResult } from "./run";
import { errorMessage } from "./http";

// A SESSION: the same simulated workday, with the agent on the outside.
//
// `runEpisode` drives the agent — beats, director, agent, next tick, as fast as
// the API will go. That only ever works for an agent we can call in-process, so
// it can benchmark our reference loop and nothing else. A customer running
// OpenClaw or Claude Code has an agent that is already alive, already has its own
// loop, and cannot be handed a callback.
//
// So a session inverts it. The baseline uses wall-clock timers at a declared
// compression. The provider-operations candidate advances the same world loop
// at trusted action and waiting boundaries, with an explicit work allowance.
// The agent is never called. It
// notices the day the way a real assistant does: by polling its own inbox,
// channels and calendar through the twins' public APIs, and acting when it
// decides to. Nothing at all is required of it beyond using the tools, which is
// what makes this work with ANY agent.
//
// Three things carry over from `runEpisode` unchanged, and that is the point:
//
//   - BEATS. The same `scheduleBeats`/`fireBeats`, keyed on the same tick index,
//     so the same spec produces the same day.
//   - THE DIRECTOR. The same `Director`, fed the same `deltas` — each twin's
//     audit rows since the last tick. It never knew who wrote those rows; an
//     external agent's mutations land in exactly the same audit log, through the
//     same routes, so the world answers it with no change whatsoever. The one
//     delivered communications are read back through recipient-scoped
//     observations. Private reasoning and original tool arguments stay absent.
//   - THE ARTIFACT. A session finishes as an `EpisodeRun` with `TickRecord[]`,
//     which is what @sonata/judge already consumes. It is scored by the same
//     checklist, the same autonomy arithmetic and the same episode judge.
//
// WHAT AN EXTERNAL AGENT'S ARTIFACT CANNOT CARRY, and is therefore left absent
// rather than invented — see `SessionRecord.caveats`, which says all of this on
// the record so a reader of the artifact is never misled by a gap:
//
//   - Its reasoning. `AgentStep.thought` never appears in a session. The agent's
//     turns happen inside its own process and are not ours to read; writing a
//     plausible-looking thought would put words in its mouth.
//   - Its reads. All three twins audit through `runMutation` only, so a search or
//     a message fetch leaves no row. A session sees what the agent CHANGED, never
//     what it looked at.
//   - Its tool arguments. Delivered communications can be read back separately
//     for colleague context, but are not a reconstruction of tool calls/reads.
//   - Its escalations, unless the harness in front of it reports them. See
//     `Session.escalate`.

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * How much simulated time passes per unit of real time. 60 is one simulated hour
 * a real minute; 1 is real time; 3600 is a workday in eight seconds.
 */
export const REAL_TIME = 1;

/** Compression factor for "n simulated hours per real minute". */
export function simHoursPerRealMinute(hours: number): number {
  return Math.max(1, hours) * 60;
}

/**
 * Real milliseconds one tick occupies. Derived from the spec's own clock rather
 * than configured separately: the tick length is the day's, and only the rate at
 * which the day is played back belongs to the session.
 */
export function realMsPerTick(clock: Clock, compression: number): number {
  const simMs = Math.max(1, clock.simMinutesPerTick) * 60_000;
  const rate = Number.isFinite(compression) && compression > 0 ? compression : REAL_TIME;
  return simMs / rate;
}

// ---------------------------------------------------------------------------
// The wall clock, behind a seam
// ---------------------------------------------------------------------------

/**
 * Real time, injected.
 *
 * A session is the one part of the engine that genuinely waits, so this is the
 * only seam a test needs to make a day of it run in milliseconds. `./live`
 * supplies the `setTimeout` implementation; tests supply a hand-cranked one.
 */
export interface SessionTimer {
  /** Wall-clock now, epoch ms. */
  now(): number;
  /** Run `fn` in `ms` of real time. Returns a cancel. */
  schedule(ms: number, fn: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Options and shape
// ---------------------------------------------------------------------------

export interface SessionOptions {
  spec: EpisodeSpec;
  timing?: SessionTimingPolicy;
  adapters: TwinAdapter[];
  /** See `realMsPerTick`. 60 = one simulated hour a real minute. */
  compression: number;
  timer: SessionTimer;
  sessionId?: string;
  director?: Director;
  /**
   * What to call the agent on the artifact, e.g. "openclaw@laptop".
   *
   * It lands in `EpisodeRun.model`, which for a scored episode is an OpenRouter
   * slug. For a session there is no such thing to know: the agent is external and
   * may not be a single model at all, so this is whatever the operator said it
   * was and is never inferred.
   */
  agentLabel?: string;
  /** Reload the cast into each twin before tick 0. Off by default. */
  seedWorld?: boolean;
  /** Reset each twin to its pristine snapshot before seeding. Off by default. */
  resetTwins?: boolean;
  /** Story rows shown to the director each tick. */
  historyLimit?: number;
  /**
   * Consecutive silent ticks that get a note on the record. Defaults to the
   * spec's `termination.idleTicks`; 0 disables the note.
   *
   * Unlike a scored episode, silence never ends a session. The world is running
   * in real time against an agent nobody is driving, and "it ignored the morning"
   * is the finding — stopping the day would destroy the evidence for it.
   */
  idleTicks?: number;
  /** Upsert this tick by index; final capture and lag notes can update it. Never throws the session. */
  onTick?: (record: TickRecord) => void;
  /** Close external admission and drain admitted requests before final capture. */
  beforeCapture?: () => Promise<void>;
}

/**
 * A finished session.
 *
 * It extends `RunResult` so that anything already written against a scored
 * episode's artifact — the judge, the results page, the store — takes a session
 * with no change and no cast.
 */
export interface SessionRecord extends RunResult {
  sessionId: string;
  /**
   * What this artifact cannot carry because the agent is not ours to instrument.
   * Written down rather than left to be noticed: every one of these is a gap that
   * looks like a finding about the agent if you do not know it is a gap.
   */
  caveats: string[];
  /** Why the day ended, in the words a page should print. */
  endedBecause: string;
}

/** Everything a status endpoint needs, cheap enough to poll. */
export interface SessionState {
  timing: SessionTimingPolicy;
  /** Only successfully delivered notifications visible to the account owner. */
  notificationSequence: number;
  sessionId: string;
  specId: string;
  specTitle: string;
  status: RunStatus;
  /** The last tick that fired; -1 before the session starts. */
  tick: number;
  /** Ticks in the whole day. */
  ticks: number;
  /** Simulated time at the start of the current tick. */
  simTimeISO: string;
  simTimeLabel: string;
  startedAt: number | null;
  endedAt: number | null;
  /** Wall-clock instant the next tick is due, or null when nothing is scheduled. */
  nextTickAt: number | null;
  beatsFired: number;
  directorEvents: number;
  /** Observable things the external agent has done, from the audit logs. */
  agentActions: number;
  /** Consecutive ticks the agent has done nothing in, right now. */
  idleStreak: number;
  longestIdleStreak: number;
  /** What has fired and what the agent has done, most recent last. */
  recent: TimelineEntry[];
  notes: string[];
}

export interface Session {
  readonly id: string;
  /** Server-side budget accounting; never part of the agent's observation. */
  modelCalls(): readonly import("@sonata/core").LlmCall[];
  /** Preflight, optionally seed, then fire tick 0 and schedule the rest. */
  start(): Promise<void>;
  status(recentLimit?: number): SessionState;
  /** Trusted gateway admission. Every request must complete, including app errors. */
  beginAction(action: SessionAction): Promise<SessionActionAdmission>;
  completeAction(actionId: string): Promise<void>;
  waitForUpdate(options: SessionWait): Promise<SessionWake>;
  /** Stop admitting work while allowing the remaining business day to unfold. */
  finishWork(): Promise<SessionRecord>;
  /**
   * Record that the agent handed the job back to a human.
   *
   * A hand-back touches no twin, so it leaves no audit row and a session cannot
   * see it. The harness in front of the agent — the MCP server exposing an
   * `escalate_to_owner` tool — calls this, and until something does, a session's
   * escalation count is zero and the autonomy score's `independence` component
   * reads as fully autonomous. That is on the caveat list rather than papered
   * over.
   */
  escalate(text: string): void;
  /** End the day early. Idempotent; resolves with the same record as `finished`. */
  stop(reason?: string): Promise<SessionRecord>;
  /**
   * Capture the episode after the harness has stopped issuing tools and drained
   * its in-flight calls. This is not a tool-access barrier: the caller owns that
   * boundary. Idempotent; the first terminal request wins.
   */
  finalize(options?: SessionFinalization): Promise<SessionRecord>;
  /** Resolves when the day ends, naturally or by `stop`. */
  finished(): Promise<SessionRecord>;
  /**
   * Resolves when the tick currently in flight has finished. For tests driving a
   * hand-cranked timer, and for a caller that wants a quiet moment to read state.
   */
  whenSettled(): Promise<void>;
}

export interface SessionAction {
  actionId: string;
  workUnits: number;
  operation: string;
}

export interface SessionActionAdmission {
  accepted: boolean;
  completionTick: number;
  simTimeISO: string;
  reason?: string;
}

export interface SessionWait {
  afterNotification: number;
  /** An explicit agent-requested wake; omitted means wait for a notification. */
  untilTick?: number;
}

export interface SessionWake {
  reason: "notification" | "timer" | "day-ended";
  notificationSequence: number;
}

export interface SessionFinalization {
  reason?: string;
  status?: "done" | "aborted" | "failed";
  /** Provider/harness failure, not an inferred failure of the agent's work. */
  error?: string;
}

// ---------------------------------------------------------------------------
// The agent's actions, read out of the world rather than out of the agent
// ---------------------------------------------------------------------------

/** GET and HEAD change nothing; everything else did. */
function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * Audit rows as `AgentStep`s.
 *
 * This is the whole trick that lets one judge score both kinds of run: in a
 * scored episode the steps come from the agent loop's own trace, and here they
 * come from the twins' record of what actually changed. The second is in some
 * ways the better evidence — it is what the world can prove happened, not what
 * the agent said it did — but it is strictly narrower, which is why the caveats
 * exist.
 *
 * `args` carries the request's identity (method, endpoint, target) and never a
 * body: the normalized audit row does not have one, and inventing plausible
 * arguments would forge the exact text the judge scores tone and accuracy on.
 */
export function stepsFromAudit(rows: TwinAuditRow[], seqFrom: number): AgentStep[] {
  return rows.map((row, i) => ({
    kind: "tool",
    seq: seqFrom + i,
    at: row.ts,
    twin: row.twin,
    name: row.actionType ?? (row.endpoint ? `${row.method} ${row.endpoint}` : "unknown action"),
    args: {
      method: row.method,
      endpoint: row.endpoint,
      ...(row.targetType ? { targetType: row.targetType } : {}),
      ...(row.targetId ? { targetId: row.targetId } : {}),
    },
    resultSummary: row.summary,
    isMutation: isMutation(row.method),
  }));
}

const CAVEATS = [
  "The agent is external, so its reasoning was never observable: this record has no thoughts.",
  "The twins audit mutations only, so what the agent read is not on the record — only what it changed.",
  "Tool arguments and reads are not captured. Delivered Gmail, Slack and supported Calendar changes can be read back for colleague context, but this is not a complete external agent trace; mentions checks based on tool arguments remain unverifiable.",
  "Colleagues receive only recipient-scoped observations. Messages missing or changed before the next poll, unsupported action types and unresolved visibility can limit what the world observes; check tick notes.",
  "Escalations appear only if the harness in front of the agent reported them; without that the autonomy score's independence component reads as fully autonomous.",
  "The trace holds the harness's own model calls (the director's) and none of the agent's, so a cost figure from it is the cost of running the world, not of running the agent.",
];

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export function createSession(opts: SessionOptions): Session {
  const { spec, timer } = opts;
  const timing = normalizeSessionTiming(opts.timing);
  const actionDriven = timing.policy === "provider-operations-v1";
  const unitsPerTick = timing.policy === "provider-operations-v1" ? timing.workUnitsPerTick : 1;
  const ownerId = owner(spec.world).id;
  const clock: SimClock = createClock(spec.clock);
  const used: ByTwin<TwinAdapter> = adaptersForSpec(spec, opts.adapters);
  const sessionId = opts.sessionId ?? `sess-${spec.id}-${timer.now()}`;
  const director = opts.director ?? createDirector({ spec });
  const refs: RefRegistry = createRefRegistry();
  const schedule = scheduleBeats(spec.beats);
  const total = Math.min(plannedTicks(spec), clock.ticks);
  const tickMs = realMsPerTick(spec.clock, opts.compression);
  const historyLimit = opts.historyLimit ?? 40;
  const idleLimit = Math.max(0, Math.floor(opts.idleTicks ?? spec.termination.idleTicks));
  // The director's calls, and only those. The agent's are made in another process
  // by a model we do not talk to — see the caveats.
  const trace: AgentTrace = newTrace(sessionId);

  const run: EpisodeRun = {
    timing,
    ...(actionDriven ? { actionLedger: [] } : {}),
    worldContextVersion: "recipient-observations-v1",
    runId: sessionId,
    specId: spec.id,
    specTitle: spec.title,
    model: opts.agentLabel ?? "external agent",
    status: "queued",
    startedAt: 0,
    endedAt: null,
    ticks: [],
    snapshots: {},
    verdict: null,
  };

  const preflight: TwinHealth[] = [];
  const cursors = new Map<TwinName, number>();
  const allAudit: TwinAuditRow[] = [];
  const pendingEscalations: string[] = [];
  const before: ByTwin<TwinSnapshot> = {};
  const sessionNotes: string[] = [];
  // Actions are captured at completion but offered to the same director on its
  // next world turn. Their evidence and logical attribution are recorded once.
  const pendingWorldActions: TwinAuditRow[] = [];
  const actionSequences = new Map<string, number>();
  const reservations = new Map<string, SessionActionRecord>();
  const wakeListeners = new Set<() => void>();

  let tick = -1;
  let seq = 0;
  /** Start of the wall-clock window the next tick will report on. See `runOneTick`. */
  let windowFrom = 0;
  let idleStreak = 0;
  let longestIdleStreak = 0;
  let idleNoticed = false;
  let nextTickAt: number | null = null;
  let cancelNext: (() => void) | null = null;
  let endedBecause = "";
  let settled: Promise<void> = Promise.resolve();
  let starting: Promise<void> | null = null;
  let closingRequested = false;
  let finishing: Promise<SessionRecord> | null = null;
  let record: SessionRecord | null = null;
  let workPosition = 0;
  let notificationSequence = 0;
  let workFinished = false;
  let finishWorkPromise: Promise<SessionRecord> | null = null;
  let activeAction: {
    record: SessionActionRecord;
    done: Promise<void>;
    release: () => void;
    completion?: Promise<void>;
  } | null = null;
  let resolveFinished: ((r: SessionRecord) => void) | null = null;
  const finishedPromise = new Promise<SessionRecord>((resolve) => {
    resolveFinished = resolve;
  });

  // -------------------------------------------------------------------------
  // Reading the world
  // -------------------------------------------------------------------------

  async function readDeltas(): Promise<TwinAuditRow[]> {
    const rows: TwinAuditRow[] = [];
    for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
      try {
        // An app cannot supply its own trusted timing attribution.
        const raw = (await adapter.auditSince(cursors.get(name) ?? 0)).map(row => {
          const copy = { ...row };
          delete copy.logicalTime;
          if (actionDriven) copy.logicalTime = null;
          return copy;
        });
        const fresh = await observeActions(adapter, raw, spec.world);
        for (const row of fresh) {
          rows.push(row);
          if (row.id > (cursors.get(name) ?? 0)) cursors.set(name, row.id);
        }
      } catch (err) {
        // A twin that cannot be read is a twin the world hears nothing from this
        // tick. The session is long-lived and a twin restart is survivable; ending
        // the day over one unreadable surface would throw away the other two.
        sessionNotes.push(`Harness observation gap: ${name} audit could not be read: ${errorMessage(err)}`);
      }
    }
    return rows.sort((a, b) => a.id - b.id);
  }

  async function snapshotAll(): Promise<ByTwin<TwinSnapshot>> {
    const out: ByTwin<TwinSnapshot> = {};
    for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
      try {
        out[name] = await adapter.snapshot();
      } catch (err) {
        // A snapshot that could not be taken is a diff that cannot be drawn. The
        // judge handles a missing pair; a thrown session loses the whole day.
        sessionNotes.push(`Harness capture gap: ${name} snapshot could not be taken: ${errorMessage(err)}`);
      }
    }
    return out;
  }

  function recordActions(rows: TwinAuditRow[]): AgentStep[] {
    allAudit.push(...rows);
    const steps = stepsFromAudit(rows, seq);
    seq += steps.length;
    rows.forEach((row, i) => {
      actionSequences.set(auditKey(row), steps[i].seq);
      const ref = auditRefName(row);
      if (ref && row.targetId) refs.record(ref, { twin: row.twin, id: row.targetId });
    });
    return steps;
  }

  function noteUnattributed(rows: TwinAuditRow[]): void {
    if (actionDriven && rows.length) sessionNotes.push(
      `Harness capture gap: ${rows.length} mutation(s) were observed outside a completed operation; their logical deadline attribution is unknown.`,
    );
  }

  // -------------------------------------------------------------------------
  // The world's own moves — the same injector a scored episode uses
  // -------------------------------------------------------------------------

  async function playEvents(events: DirectorEvent[], atISO: string): Promise<DirectorEvent[]> {
    const played: DirectorEvent[] = [];
    const inject = { adapters: used, world: spec.world, refs };
    for (const event of events) {
      const outcome = await injectBody(event, atISO, inject);
      if (outcome.handle) refs.record(event.id, outcome.handle);
      played.push({
        ...event,
        observation: outcome.error ? undefined : bodyObservation(event, spec.world),
        ...(outcome.handle ? { handle: outcome.handle } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }
    return played;
  }

  // Advance one simulated interval using the existing session loop.
  async function runOneTick(at: number): Promise<void> {
    tick = at;
    // A tick claims the whole wall-clock window it OBSERVED, not just the moment
    // it spent processing.
    //
    // In a scored episode those are the same thing: the agent runs inside the tick,
    // so its steps are stamped between the tick's start and end. Here the agent ran
    // in the gap between two ticks, and a tick that claimed only its own few
    // milliseconds would contain steps timestamped outside itself — which is
    // exactly what @sonata/judge's `tickIndexer` looks for, so every action would
    // land on no tick at all and every criterion would lose its `tick`.
    const startedAt = windowFrom;
    const simTimeISO = clock.isoAt(at);
    const notes: string[] = [];

    // 1. WHAT THE AGENT DID, read before this tick's beats fire.
    //
    // A scored episode fires beats first, because the agent has not run yet. Here
    // the agent has been running the whole time, so the delta is read at the
    // instant the previous window closes — otherwise an action taken in the
    // milliseconds after a beat landed would be credited to the tick that beat
    // arrived on, and the agent would look precognitive.
    const fresh = await readDeltas();
    noteUnattributed(fresh);
    const deltas = [...pendingWorldActions.splice(0), ...fresh];
    const agentSteps: AgentStep[] = recordActions(fresh);
    // Which step wrote which row — an index, not an inference: `stepsFromAudit`
    // emits exactly one step per row, in order, so a session gets this link for
    // free where a scored episode has to pair for it.
    //
    // Step attribution is local to this session. Delivered message prose and
    // audience arrive through adapter observations, identically to hosted runs;
    // they do not reconstruct the external agent's tool arguments.
    const deltaDetail = new Map<string, DeltaDetail>(
      deltas.map(row => [auditKey(row), { seq: actionSequences.get(auditKey(row))! }]),
    );
    const reportedAt = timer.now();
    while (pendingEscalations.length) {
      const text = pendingEscalations.shift();
      if (text !== undefined) agentSteps.push({ kind: "escalation", seq: seq++, at: reportedAt, text });
    }

    // Save the evidence before asking the world to react. A provider exception
    // must not erase an already-observed mutation or a beat that was delivered.
    const tickRecord: TickRecord = {
      tick: at,
      simTimeISO,
      startedAt,
      endedAt: timer.now(),
      observedActions: fresh,
      beatsFired: [],
      directorEvents: [],
      agentSteps,
      notes,
    };
    run.ticks.push(tickRecord);

    try {
      // 2. BEATS. Injected through the twins' sandbox routes, which are not audited —
      // which is exactly why the delta above is the agent's work and nobody else's.
      //
      // An adaptive beat needs no reordering here, and that is a property of this
      // loop rather than an accident: a session reads the agent's work FIRST, above,
      // because the agent has been running the whole time. So by the time a beat is
      // reworded, `allAudit` already holds everything the agent did up to this
      // instant — where a scored episode has to go and read it early on purpose.
      // Rewrites can use delivered observations, not private tool arguments.
      const adapted = await adaptBeats(schedule.at(at), {
        spec,
        director,
        adapters: used,
        before,
        audit: allAudit,
        ticks: run.ticks.slice(0, -1),
        tick: at,
        simTimeLabel: clock.labelAt(at),
      });
      notes.push(...adapted.notes);

      const beatsFired: BeatFired[] = await fireBeats(
        adapted.beats,
        simTimeISO,
        { adapters: used, world: spec.world, refs },
        adapted.assessments,
      );
      tickRecord.beatsFired = beatsFired;

      // 3. Director: the same recipient-scoped observations as a hosted run.
      const events = await director.react({
        tick: at,
        simTimeISO,
        simTimeLabel: clock.labelAt(at),
        history: colleagueHistory(run.ticks.slice(0, -1), historyLimit),
        deltas,
        deltaDetail,
        beatsThisTick: beatsFired,
      });
      const directorEvents = await playEvents(events, simTimeISO);
      tickRecord.directorEvents = directorEvents;
      const note = director.lastNote();
      if (note) notes.push(note);

      for (const beat of beatsFired) if (beat.error) notes.push(`beat ${beat.beatId}: ${beat.error}`);
      for (const event of directorEvents) if (event.error) notes.push(`event ${event.id}: ${event.error}`);
    } catch (err) {
      tickRecord.harnessError = errorMessage(err);
      notes.push(`tick ${at} failed: ${tickRecord.harnessError}`);
    }
    for (const row of deltas) if (row.observationError) notes.push(row.observationError);
    windowFrom = timer.now();
    tickRecord.endedAt = windowFrom;

    // Idle is recorded, never enforced. A session's whole subject is an agent
    // nobody is driving, so "it did nothing all morning" is the measurement, and
    // ending the day over it would destroy the evidence for it.
    if (didSomething(tickRecord) || deltas.length > 0) {
      if (idleNoticed) {
        tickRecord.notes.push(`the agent acted again after ${idleStreak} silent interval(s)`);
      }
      idleStreak = 0;
      idleNoticed = false;
    } else {
      idleStreak += 1;
      if (idleStreak > longestIdleStreak) longestIdleStreak = idleStreak;
      if (idleLimit > 0 && idleStreak >= idleLimit && !idleNoticed) {
        tickRecord.notes.push(`the agent has done nothing for ${idleStreak} consecutive interval(s)`);
        idleNoticed = true;
      }
    }

    // Publish setup and observation gaps on the next recorded tick. Finalisation
    // also drains this list, so a failure at the end cannot disappear.
    if (sessionNotes.length) tickRecord.notes.unshift(...sessionNotes.splice(0));
    for (const event of [...tickRecord.beatsFired, ...tickRecord.directorEvents]) {
      if (!event.error && event.handle && ["gmail", "slack", "calendar"].includes(event.twin) &&
          event.observation?.audience.includes(ownerId) && event.observation.actor !== ownerId) {
        notificationSequence++;
      }
    }
    notifyTick(tickRecord);
  }

  function notifyTick(tickRecord: TickRecord): void {
    try {
      opts.onTick?.(tickRecord);
    } catch {
      // A dashboard callback that throws is the dashboard's problem, not the day's.
    }
    for (const listener of wakeListeners) listener();
  }

  // -------------------------------------------------------------------------
  // Trusted operation admission and the experimental work allowance
  // -------------------------------------------------------------------------

  function businessISO(): string {
    return actionDriven
      ? new Date(Date.parse(clock.isoAt(0)) + workPosition / unitsPerTick * spec.clock.simMinutesPerTick * 60_000).toISOString()
      : clock.isoAt(Math.max(0, tick));
  }

  function businessTick(): number {
    return actionDriven ? Math.floor(workPosition / unitsPerTick) : Math.max(0, tick);
  }

  /** Every intervening world turn still runs, including private events and deadlines. */
  async function advanceWork(to: number): Promise<void> {
    const target = Math.min(to, total * unitsPerTick);
    while (!closingRequested && tick + 1 < total && (tick + 1) * unitsPerTick <= target) {
      workPosition = (tick + 1) * unitsPerTick;
      await guarded(tick + 1);
    }
    if (!closingRequested) workPosition = target;
  }

  function admission(accepted: boolean, reason?: string): SessionActionAdmission {
    return { accepted, completionTick: businessTick(), simTimeISO: businessISO(), ...(reason ? { reason } : {}) };
  }

  async function beginAction(action: SessionAction): Promise<SessionActionAdmission> {
    if (!action || typeof action.actionId !== "string" || !action.actionId.trim() || action.actionId.length > 200 ||
        typeof action.operation !== "string" || !action.operation.trim() || action.operation.length > 500 ||
        !Number.isSafeInteger(action.workUnits) || action.workUnits <= 0) {
      throw new Error("An action requires a unique actionId, operation and positive integer workUnits");
    }
    if (closingRequested || workFinished || run.status !== "running") return admission(false, "the session is not accepting work");
    const decision = await enqueue(async () => {
      if (reservations.has(action.actionId)) return admission(false, "actionId has already been used");
      if (closingRequested || workFinished || run.status !== "running") return admission(false, "the session is not accepting work");
      const entry: SessionActionRecord = {
        ...action, fromWorkUnits: workPosition, completionWorkUnits: workPosition,
        completionTick: businessTick(), simTimeISO: businessISO(), admittedAt: timer.now(), state: "rejected",
      };
      reservations.set(action.actionId, entry);
      run.actionLedger?.push(entry);
      if (activeAction) {
        entry.reason = "another operation is still in flight";
        return admission(false, entry.reason);
      }
      if (actionDriven) {
        // Completion ordering is conservative: boundary events win ties. The
        // external request is not permitted until these events have landed.
        const remaining = total * unitsPerTick - workPosition;
        await advanceWork(workPosition + Math.min(action.workUnits, remaining));
      }
      entry.completionWorkUnits = workPosition;
      entry.completionTick = businessTick();
      entry.simTimeISO = businessISO();
      if (closingRequested || workFinished || (actionDriven && workPosition >= total * unitsPerTick)) {
        entry.reason = closingRequested || workFinished ? "the session is closing" : "the operation would complete at or after day end";
        return admission(false, entry.reason);
      }
      entry.state = "admitted";
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      activeAction = { record: entry, done, release };
      return admission(true);
    });
    // Do not await capture here: the gateway must receive this rejection before
    // its beforeCapture drain can acknowledge that no request was admitted.
    if (actionDriven && workPosition >= total * unitsPerTick && !finishing) void finish("the simulated day ended");
    return decision;
  }

  function completeAction(actionId: string): Promise<void> {
    const entry = reservations.get(actionId);
    if (entry?.state === "completed") return Promise.resolve();
    const active = activeAction;
    if (!active || active.record.actionId !== actionId) return Promise.reject(new Error("No admitted operation matches actionId"));
    if (active.completion) return active.completion;
    // Deliberately outside the world queue: terminal capture may be waiting for
    // this lease. No candidate world turn is allowed while the lease is active.
    active.completion = (async () => {
      try {
        if (actionDriven) {
          const rows = await readDeltas();
          for (const row of rows) row.logicalTime = {
            actionId, tick: active.record.completionTick, simTimeISO: active.record.simTimeISO,
          };
          const steps = recordActions(rows);
          const current = run.ticks.find(t => t.tick === active.record.completionTick);
          if (!current) throw new Error("No world interval exists for the completed operation");
          current.observedActions ??= [];
          current.observedActions.push(...rows);
          current.agentSteps.push(...steps);
          current.endedAt = timer.now();
          for (const row of rows) if (row.observationError) current.notes.push(row.observationError);
          pendingWorldActions.push(...rows);
          if (rows.length) { idleStreak = 0; idleNoticed = false; }
          notifyTick(current);
        }
        active.record.state = "completed";
        active.record.completedAt = timer.now();
      } catch (err) {
        sessionNotes.push(`Harness capture gap: operation ${actionId} could not be captured: ${errorMessage(err)}`);
        throw err;
      } finally {
        activeAction = null;
        active.release();
      }
    })();
    return active.completion;
  }

  function wakeReason(options: SessionWait): SessionWake["reason"] | undefined {
    if (closingRequested || ["done", "aborted", "failed"].includes(run.status) ||
        (actionDriven && workPosition >= total * unitsPerTick)) return "day-ended";
    if (notificationSequence > options.afterNotification) return "notification";
    if (options.untilTick !== undefined && businessTick() >= options.untilTick) return "timer";
    return undefined;
  }

  async function waitForUpdate(options: SessionWait): Promise<SessionWake> {
    if (!options || !Number.isSafeInteger(options.afterNotification) || options.afterNotification < 0 ||
        options.afterNotification > notificationSequence || (options.untilTick !== undefined &&
        (!Number.isInteger(options.untilTick) || options.untilTick < 0 || options.untilTick > total))) {
      throw new Error("Wait requires an observed notification sequence and an optional tick within the day");
    }
    if (activeAction) throw new Error("Complete the admitted operation before waiting");
    if (run.status === "queued") throw new Error("Start the session before waiting");
    if (!actionDriven) {
      return new Promise(resolve => {
        const check = () => {
          const reason = wakeReason(options);
          if (reason) { wakeListeners.delete(check); resolve({ reason, notificationSequence }); }
        };
        wakeListeners.add(check);
        check();
      });
    }
    const reason = await enqueue(async () => {
      if (activeAction) throw new Error("Complete the admitted operation before waiting");
      while (!wakeReason(options)) await advanceWork((tick + 1) * unitsPerTick);
      return wakeReason(options)!;
    });
    if (reason === "day-ended" && !closingRequested) await finish("the simulated day ended");
    return { reason, notificationSequence };
  }

  function finishWork(): Promise<SessionRecord> {
    if (finishWorkPromise) return finishWorkPromise;
    workFinished = true;
    if (!actionDriven) return finishedPromise;
    finishWorkPromise = (async () => {
      await enqueue(async () => {
        await activeAction?.done;
        if (!closingRequested) await advanceWork(total * unitsPerTick);
      });
      return finish("the agent declared its work finished; the remaining simulated day was processed");
    })();
    return finishWorkPromise;
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Absolute wall-clock instant a tick is due — from the start, so drift cannot accumulate. */
  function dueAt(at: number): number {
    return run.startedAt + at * tickMs;
  }

  function scheduleNext(): void {
    if (actionDriven) return;
    if (closingRequested || run.status !== "running") return;
    const next = tick + 1;
    const delay = Math.max(0, dueAt(next) - timer.now());
    nextTickAt = timer.now() + delay;
    cancelNext = timer.schedule(delay, () => {
      cancelNext = null;
      nextTickAt = null;
      if (closingRequested || run.status !== "running") return;
      // Tick N−1 opens the final interval; the day ends at boundary N. There is
      // no extra world turn at N, but the agent gets the entire final interval.
      if (next >= total) {
        void finish("the simulated day ended");
        return;
      }
      enqueue(async () => {
        if (closingRequested || run.status !== "running") return;
        const lag = timer.now() - dueAt(next);
        await guarded(next);
        // Said out loud rather than silently absorbed: a world running behind the
        // wall clock is a world whose beats no longer land when the spec says.
        const landed = run.ticks[run.ticks.length - 1];
        if (lag > tickMs && landed?.tick === next) {
          landed.notes.push(`the world is ${Math.round(lag)}ms behind the wall clock`);
          notifyTick(landed);
        }
        scheduleNext();
      });
    });
  }

  /** A tick that throws is a note on the record, never the end of the day. */
  async function guarded(at: number): Promise<void> {
    try {
      await withTrace(trace, () => runOneTick(at));
    } catch (err) {
      const message = `tick ${at} failed: ${errorMessage(err)}`;
      const last = run.ticks[run.ticks.length - 1];
      if (last && last.tick === at) {
        last.notes.push(message);
        last.harnessError = errorMessage(err);
        last.endedAt = timer.now();
        notifyTick(last);
      }
      else sessionNotes.push(message);
    }
  }

  /**
   * Serialize everything that touches the world. Ticks are async and the timer is
   * not: without this, a slow tick and the next one due would interleave their
   * audit reads and each would see half the agent's work.
   */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // The trailing catch keeps `settled` permanently fulfilled: a caller awaiting
    // it wants to know the world is quiet, not to be handed a tick's failure.
    const task = settled.then(fn);
    settled = task.then(() => undefined, () => undefined);
    return task;
  }

  // -------------------------------------------------------------------------
  // Finishing
  // -------------------------------------------------------------------------

  function result(): SessionRecord {
    return {
      sessionId,
      run,
      trace,
      audit: [...allAudit].sort((a, b) => a.id - b.id),
      refs: Object.fromEntries(Object.entries(refs.entries()).map(([k, v]) => [k, v.id])),
      preflight,
      caveats: [...CAVEATS, ...sessionNotes],
      endedBecause,
    };
  }

  /**
   * The day ends once. `stop` racing the natural end is the normal case — an
   * operator clicking stop as the last tick lands — so the guard is a promise and
   * not a flag: a flag would let the second caller past while the first is still
   * awaiting its closing snapshots.
   */
  function finish(reason: string, status: RunStatus = "done", error?: string): Promise<SessionRecord> {
    if (!finishing) {
      closingRequested = true;
      cancelNext?.();
      cancelNext = null;
      nextTickAt = null;
      // Capture the current chain before extending it: finalisation must wait
      // for setup/ticks, and must never wait on its own promise.
      const pending = settled;
      finishing = (async () => {
        await pending;
        try {
          // Admission was closed above, but an admitted gateway request can
          // still completeAction outside this queue. The hook must keep its
          // completion pump alive until its external requests have drained.
          await opts.beforeCapture?.();
          await activeAction?.done;
        } catch (err) {
          const gap = `Harness capture gap: admitted operations could not be drained: ${errorMessage(err)}`;
          sessionNotes.push(gap);
          return closeOut(reason, "failed", [error, gap].filter(Boolean).join("; "), false);
        }
        return closeOut(reason, status, error);
      })();
      settled = finishing.then(() => undefined);
    }
    return finishing;
  }

  async function closeOut(reason: string, status: RunStatus, error?: string, captureSafe = true): Promise<SessionRecord> {
    endedBecause = reason;
    cancelNext?.();
    cancelNext = null;
    nextTickAt = null;

    // The final interval has no subsequent world tick to read it. Drain its
    // mutations exactly once, without firing beats or inventing a world reply.
    // The external harness must already have stopped and drained its tool calls.
    const last = run.ticks[run.ticks.length - 1];
    const deltas = captureSafe && tick >= 0 ? await readDeltas() : [];
    noteUnattributed(deltas);
    const steps = recordActions(deltas);
    if (last) {
      last.observedActions ??= [];
      last.observedActions.push(...deltas);
      last.agentSteps.push(...steps);
      for (const row of deltas) {
        const name = auditRefName(row);
        if (name && row.targetId) refs.record(name, { twin: row.twin, id: row.targetId });
        if (row.observationError) last.notes.push(row.observationError);
      }
      if (deltas.length) {
        last.notes.push(`Final capture retained ${deltas.length} action(s) after the last world poll; no further world response was simulated.`);
        idleStreak = 0;
      }
    }
    while (pendingEscalations.length) {
      const text = pendingEscalations.shift();
      if (text !== undefined && last) {
        last.agentSteps.push({ kind: "escalation", seq: seq++, at: timer.now(), text });
      }
    }

    const after = captureSafe ? await snapshotAll() : {};
    for (const name of Object.keys(used) as TwinName[]) {
      const pre = before[name];
      const post = after[name];
      if (pre && post) run.snapshots[name] = { before: pre, after: post };
    }

    run.status = status;
    if (error) run.error = error;
    if (!run.startedAt) run.startedAt = timer.now();
    run.endedAt = timer.now();
    if (last) {
      last.endedAt = run.endedAt;
      last.notes.push(...sessionNotes.splice(0));
      if (error) {
        last.harnessError = error;
        last.notes.push(`Session finalisation: ${error}`);
      }
      notifyTick(last);
    }
    record = result();
    resolveFinished?.(record);
    for (const listener of wakeListeners) listener();
    return record;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function startSession(): Promise<void> {
    try {
      for (const adapter of Object.values(used)) {
        if (closingRequested) return;
        const health = await adapter.health();
        preflight.push(health);
        if (!health.ok) throw new Error(`${adapter.name} failed preflight`);
      }
      if (opts.resetTwins) for (const adapter of Object.values(used)) {
        if (closingRequested) return;
        await adapter.reset();
      }
      if (opts.seedWorld) for (const adapter of Object.values(used)) {
        if (closingRequested) return;
        await adapter.seed(spec);
      }
      if (closingRequested) return;

      // The `before` snapshot is taken AFTER seeding: the diff has to show what
      // the agent changed, not what the seeder wrote.
      Object.assign(before, await snapshotAll());

      // The audit cursor starts at whatever seeding left behind, so setup writes
      // are never read back as the agent's work.
      for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
        if (closingRequested) return;
        try {
          const existing = await adapter.auditSince(0);
          for (const row of existing) cursors.set(name, Math.max(cursors.get(name) ?? 0, row.id));
        } catch (err) {
          // Without a baseline, a later successful poll would count old setup
          // writes as the agent's work. Refuse that ambiguous attribution.
          throw new Error(`${name} audit baseline could not be read: ${errorMessage(err)}`);
        }
      }

      sessionNotes.push(...specWarnings(spec, used));
    } catch (err) {
      if (closingRequested) {
        sessionNotes.push(`Session setup failed during cancellation: ${errorMessage(err)}`);
        return;
      }
      run.status = "failed";
      run.error = errorMessage(err);
      run.startedAt = timer.now();
      run.endedAt = timer.now();
      endedBecause = `the session could not start: ${run.error}`;
      record = result();
      finishing = Promise.resolve(record);
      resolveFinished?.(record);
      return;
    }

    if (closingRequested) return;
    run.status = "running";
    run.startedAt = timer.now();
    windowFrom = run.startedAt;

    if (total <= 0) {
      closingRequested = true;
      finishing = closeOut("the spec has no ticks to run", "done");
      await finishing;
      return;
    }

    // Tick 0 is the start of the day, so it happens now rather than one tick
    // interval from now — and it happens inside `start`, so a caller that has
    // awaited start knows the day has begun.
    await guarded(0);
    scheduleNext();
  }

  return {
    id: sessionId,

    start(): Promise<void> {
      if (starting) return starting;
      if (run.status !== "queued" || closingRequested) return Promise.resolve();
      starting = startSession();
      settled = starting;
      return starting;
    },

    status(recentLimit = 50): SessionState {
      const all = runTimeline(run.ticks);
      const at = Math.max(0, tick);
      return {
        timing,
        notificationSequence,
        sessionId,
        specId: spec.id,
        specTitle: spec.title,
        status: run.status,
        tick,
        ticks: total,
        simTimeISO: businessISO(),
        simTimeLabel: actionDriven ? businessISO().slice(11, 16) : clock.labelAt(at),
        startedAt: run.status === "queued" ? null : run.startedAt,
        endedAt: run.endedAt,
        nextTickAt,
        beatsFired: run.ticks.reduce((n, t) => n + t.beatsFired.length, 0),
        directorEvents: run.ticks.reduce((n, t) => n + t.directorEvents.length, 0),
        agentActions: run.ticks.reduce((n, t) => n + t.agentSteps.length, 0),
        idleStreak,
        longestIdleStreak,
        recent: recentLimit >= all.length ? all : all.slice(all.length - recentLimit),
        notes: [...run.ticks.flatMap((t) => t.notes), ...sessionNotes],
      };
    },

    beginAction,
    completeAction,
    waitForUpdate,
    finishWork,

    modelCalls() { return trace.llmCalls; },

    escalate(text: string): void {
      if (!closingRequested) pendingEscalations.push(text);
    },

    stop(reason = "the session was stopped"): Promise<SessionRecord> {
      return finish(reason, "aborted");
    },

    finalize(options = {}): Promise<SessionRecord> {
      return finish(options.reason ?? "the harness finalised the episode", options.status ?? "done", options.error);
    },

    finished(): Promise<SessionRecord> {
      return finishedPromise;
    },

    whenSettled(): Promise<void> {
      return settled;
    },
  };
}
