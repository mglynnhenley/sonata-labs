import {
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
  summarizeBody,
  type RefRegistry,
} from "./beats";
import {
  auditRefName,
  createDirector,
  type DeltaDetail,
  type Director,
  type UpcomingBeat,
} from "./director";
import { recentHistory, runTimeline } from "./timeline";
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
// So a session inverts it. The world runs on WALL-CLOCK timers at a declared
// compression — one simulated hour a real minute, say — and fires its beats and
// its director whether or not anything is watching. The agent is never called. It
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
//     thing it is fed LESS of is the agent's prose, which does not exist here:
//     the world reacts to metadata alone. See the tool-arguments caveat below.
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
//   - Its tool arguments. The normalized `TwinAuditRow` carries a summary, not the
//     request body, so the prose the agent wrote is not recoverable from a session.
//     `writtenFromTicks` therefore comes back empty and `mentions` criteria read as
//     unverifiable — undercrediting, which is the safe direction. It also means the
//     DIRECTOR is shown less here than in a scored episode, where it reads what the
//     agent actually wrote: a session's world judges a reply by its subject line.
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
  /** Called after each tick, for a live dashboard. Never throws the session. */
  onTick?: (record: TickRecord) => void;
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
  /** Preflight, optionally seed, then fire tick 0 and schedule the rest. */
  start(): Promise<void>;
  status(recentLimit?: number): SessionState;
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
  /** Resolves when the day ends, naturally or by `stop`. */
  finished(): Promise<SessionRecord>;
  /**
   * Resolves when the tick currently in flight has finished. For tests driving a
   * hand-cranked timer, and for a caller that wants a quiet moment to read state.
   */
  whenSettled(): Promise<void>;
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
  "Audit rows carry a summary, not a request body, so the prose the agent wrote is not recoverable; `mentions` criteria will read as unverifiable rather than passing.",
  "The world therefore reacted to metadata alone — subjects, recipients, what changed — and never to what the agent actually wrote. A scored episode's director is shown the reply itself, so a session's people cannot tell a thorough answer from a thin one and may be harsher, or kinder, than the reply deserved.",
  "That metadata is also all that decides WHO in this world has a reason to answer: casting reads the audit summary, so someone the agent named only inside a message body is never cast here, where a scored episode would have cast them.",
  "An adaptive beat still adapts here — its condition is settled from the audit log and the snapshots, which a session has — but the person rewording it is shown no prose either, so their new wording reacts to the fact of a reply and never to its content.",
  "Escalations appear only if the harness in front of the agent reported them; without that the autonomy score's independence component reads as fully autonomous.",
  "The trace holds the harness's own model calls (the director's) and none of the agent's, so a cost figure from it is the cost of running the world, not of running the agent.",
];

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export function createSession(opts: SessionOptions): Session {
  const { spec, timer } = opts;
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
  let finishing: Promise<SessionRecord> | null = null;
  let record: SessionRecord | null = null;
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
        const fresh = await adapter.auditSince(cursors.get(name) ?? 0);
        for (const row of fresh) {
          rows.push(row);
          if (row.id > (cursors.get(name) ?? 0)) cursors.set(name, row.id);
        }
      } catch {
        // A twin that cannot be read is a twin the world hears nothing from this
        // tick. The session is long-lived and a twin restart is survivable; ending
        // the day over one unreadable surface would throw away the other two.
      }
    }
    return rows.sort((a, b) => a.id - b.id);
  }

  async function snapshotAll(): Promise<ByTwin<TwinSnapshot>> {
    const out: ByTwin<TwinSnapshot> = {};
    for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
      try {
        out[name] = await adapter.snapshot();
      } catch {
        // A snapshot that could not be taken is a diff that cannot be drawn. The
        // judge handles a missing pair; a thrown session loses the whole day.
      }
    }
    return out;
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
        ...(outcome.handle ? { handle: outcome.handle } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    }
    return played;
  }

  /**
   * One line per beat still to come, so the world does not pre-empt the script.
   * Carries the twin for the same reason `runEpisode`'s copy does: a character is
   * only ever shown the surfaces they are on.
   */
  function upcomingLines(after: number): UpcomingBeat[] {
    return spec.beats
      .filter((b) => b.tick > after && b.tick < clock.ticks)
      .sort((a, b) => a.tick - b.tick)
      .map((b) => ({ twin: b.twin, line: `${clock.labelAt(b.tick)} — ${summarizeBody(b, spec.world)}` }));
  }

  // -------------------------------------------------------------------------
  // One tick
  // -------------------------------------------------------------------------

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
    const deltas = await readDeltas();
    allAudit.push(...deltas);
    // Offer the world a ref for each thing the agent just did, under the same name
    // the director's prompt hands the model, so a reply can attach to it.
    for (const row of deltas) {
      const name = auditRefName(row);
      if (name && row.targetId) refs.record(name, { twin: row.twin, id: row.targetId });
    }

    const agentSteps: AgentStep[] = stepsFromAudit(deltas, seq);
    seq += agentSteps.length;
    // Which step wrote which row — an index, not an inference: `stepsFromAudit`
    // emits exactly one step per row, in order, so a session gets this link for
    // free where a scored episode has to pair for it.
    //
    // `seq` is the only half of `DeltaDetail` fillable here. `prose` stays absent
    // because it does not exist: the request bodies never reached us, and a
    // plausible-looking body would put words in the agent's mouth and then let
    // the world react to them. CAVEATS says so on the record.
    //
    // Keyed by `auditKey` and not by `row.id`: the twins number their audit logs
    // independently, so a tick that saw both an email and a Slack post holds two
    // different rows with the same id.
    const deltaDetail = new Map<string, DeltaDetail>(
      deltas.map((row, i) => [auditKey(row), { seq: agentSteps[i].seq }]),
    );
    const reportedAt = timer.now();
    while (pendingEscalations.length) {
      const text = pendingEscalations.shift();
      if (text !== undefined) agentSteps.push({ kind: "escalation", seq: seq++, at: reportedAt, text });
    }

    // 2. BEATS. Injected through the twins' sandbox routes, which are not audited —
    // which is exactly why the delta above is the agent's work and nobody else's.
    //
    // An adaptive beat needs no reordering here, and that is a property of this
    // loop rather than an accident: a session reads the agent's work FIRST, above,
    // because the agent has been running the whole time. So by the time a beat is
    // reworded, `allAudit` already holds everything the agent did up to this
    // instant — where a scored episode has to go and read it early on purpose.
    // What a session cannot give the rewrite is the agent's PROSE; see CAVEATS.
    const adapted = await adaptBeats(schedule.at(at), {
      spec,
      director,
      adapters: used,
      before,
      audit: allAudit,
      ticks: run.ticks,
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

    // 3. DIRECTOR. The same inputs a scored episode gives it, minus the one a
    // session cannot have: it is shown the deltas and this tick's beats but not
    // the prose behind them, and it has no way of telling — nor any reason to
    // care — that the deltas came from someone else's agent.
    const events = await director.react({
      tick: at,
      simTimeISO,
      simTimeLabel: clock.labelAt(at),
      history: recentHistory(run.ticks, historyLimit),
      deltas,
      deltaDetail,
      beatsThisTick: beatsFired,
      upcoming: upcomingLines(at),
    });
    const directorEvents = await playEvents(events, simTimeISO);
    const note = director.lastNote();
    if (note) notes.push(note);

    for (const beat of beatsFired) if (beat.error) notes.push(`beat ${beat.beatId}: ${beat.error}`);
    for (const event of directorEvents) if (event.error) notes.push(`event ${event.id}: ${event.error}`);

    windowFrom = timer.now();
    const tickRecord: TickRecord = {
      tick: at,
      simTimeISO,
      startedAt,
      endedAt: windowFrom,
      beatsFired,
      directorEvents,
      agentSteps,
      notes,
    };

    // Idle is recorded, never enforced. A session's whole subject is an agent
    // nobody is driving, so "it did nothing all morning" is the measurement, and
    // ending the day over it would destroy the evidence for it.
    if (didSomething(tickRecord)) {
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

    // Drained onto whichever tick comes next, not onto tick 0 alone.
    //
    // Tick 0 is where the authoring warnings land and that is unchanged, because
    // they are the only thing on the list when it runs. What was being thrown away
    // is the other writer: `guarded` puts "tick N failed" here when a tick threw
    // before it could push a record of its own, and for every N but 0 that message
    // went onto a list nothing read again. A tick that vanished from the artifact,
    // with the day carrying on around the hole and no note anywhere saying so, is
    // the report overstating its evidence.
    if (sessionNotes.length) tickRecord.notes.unshift(...sessionNotes.splice(0));
    run.ticks.push(tickRecord);
    try {
      opts.onTick?.(tickRecord);
    } catch {
      // A dashboard callback that throws is the dashboard's problem, not the day's.
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Absolute wall-clock instant a tick is due — from the start, so drift cannot accumulate. */
  function dueAt(at: number): number {
    return run.startedAt + at * tickMs;
  }

  function scheduleNext(): void {
    const next = tick + 1;
    if (next >= total) {
      // Enqueued rather than awaited so the natural end sits on the same chain as
      // the ticks — `whenSettled` then covers the whole day, finish included.
      enqueue(() => finish("the simulated day ended").then(() => undefined));
      return;
    }
    const delay = Math.max(0, dueAt(next) - timer.now());
    nextTickAt = timer.now() + delay;
    cancelNext = timer.schedule(delay, () => {
      cancelNext = null;
      nextTickAt = null;
      enqueue(async () => {
        if (run.status !== "running") return;
        const lag = timer.now() - dueAt(next);
        await guarded(next);
        // Said out loud rather than silently absorbed: a world running behind the
        // wall clock is a world whose beats no longer land when the spec says.
        const landed = run.ticks[run.ticks.length - 1];
        if (lag > tickMs && landed?.tick === next) {
          landed.notes.push(`the world is ${Math.round(lag)}ms behind the wall clock`);
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
      if (last && last.tick === at) last.notes.push(message);
      else sessionNotes.push(message);
    }
  }

  /**
   * Serialize everything that touches the world. Ticks are async and the timer is
   * not: without this, a slow tick and the next one due would interleave their
   * audit reads and each would see half the agent's work.
   */
  function enqueue(fn: () => Promise<void>): void {
    // The trailing catch keeps `settled` permanently fulfilled: a caller awaiting
    // it wants to know the world is quiet, not to be handed a tick's failure.
    settled = settled.then(fn).catch(() => undefined);
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
      caveats: CAVEATS,
      endedBecause,
    };
  }

  /**
   * The day ends once. `stop` racing the natural end is the normal case — an
   * operator clicking stop as the last tick lands — so the guard is a promise and
   * not a flag: a flag would let the second caller past while the first is still
   * awaiting its closing snapshots.
   */
  function finish(reason: string, status: RunStatus = "done"): Promise<SessionRecord> {
    if (!finishing) finishing = closeOut(reason, status);
    return finishing;
  }

  async function closeOut(reason: string, status: RunStatus): Promise<SessionRecord> {
    endedBecause = reason;
    cancelNext?.();
    cancelNext = null;
    nextTickAt = null;

    // Anything the harness reported after the last tick still belongs to the day.
    const last = run.ticks[run.ticks.length - 1];
    while (pendingEscalations.length) {
      const text = pendingEscalations.shift();
      if (text !== undefined && last) {
        last.agentSteps.push({ kind: "escalation", seq: seq++, at: timer.now(), text });
      }
    }

    const after = await snapshotAll();
    for (const name of Object.keys(used) as TwinName[]) {
      const pre = before[name];
      const post = after[name];
      if (pre && post) run.snapshots[name] = { before: pre, after: post };
    }

    run.status = status;
    run.endedAt = timer.now();
    record = result();
    resolveFinished?.(record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  return {
    id: sessionId,

    async start(): Promise<void> {
      if (run.status !== "queued") return;
      try {
        for (const adapter of Object.values(used)) preflight.push(await adapter.health());
        if (opts.resetTwins) for (const adapter of Object.values(used)) await adapter.reset();
        if (opts.seedWorld) for (const adapter of Object.values(used)) await adapter.seed(spec);

        // The `before` snapshot is taken AFTER seeding: the diff has to show what
        // the agent changed, not what the seeder wrote.
        Object.assign(before, await snapshotAll());

        // The audit cursor starts at whatever seeding left behind, so setup writes
        // are never read back as the agent's work.
        for (const [name, adapter] of Object.entries(used) as [TwinName, TwinAdapter][]) {
          try {
            const existing = await adapter.auditSince(0);
            const lastRow = existing[existing.length - 1];
            if (lastRow) cursors.set(name, lastRow.id);
          } catch {
            // Unreadable now means unreadable later; readDeltas reports it then.
          }
        }

        sessionNotes.push(...specWarnings(spec, used));
      } catch (err) {
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

      run.status = "running";
      run.startedAt = timer.now();
      windowFrom = run.startedAt;

      if (total <= 0) {
        await finish("the spec has no ticks to run");
        return;
      }

      // Tick 0 is the start of the day, so it happens now rather than one tick
      // interval from now — and it happens inside `start`, so a caller that has
      // awaited start knows the day has begun.
      await guarded(0);
      scheduleNext();
    },

    status(recentLimit = 50): SessionState {
      const all = runTimeline(run.ticks);
      const at = Math.max(0, tick);
      return {
        sessionId,
        specId: spec.id,
        specTitle: spec.title,
        status: run.status,
        tick,
        ticks: total,
        simTimeISO: clock.isoAt(at),
        simTimeLabel: clock.labelAt(at),
        startedAt: run.status === "queued" ? null : run.startedAt,
        endedAt: run.endedAt,
        nextTickAt,
        beatsFired: run.ticks.reduce((n, t) => n + t.beatsFired.length, 0),
        directorEvents: run.ticks.reduce((n, t) => n + t.directorEvents.length, 0),
        agentActions: run.ticks.reduce((n, t) => n + t.agentSteps.length, 0),
        idleStreak,
        longestIdleStreak,
        recent: recentLimit >= all.length ? all : all.slice(all.length - recentLimit),
        notes: run.ticks.flatMap((t) => t.notes),
      };
    },

    escalate(text: string): void {
      pendingEscalations.push(text);
    },

    async stop(reason = "the session was stopped"): Promise<SessionRecord> {
      cancelNext?.();
      cancelNext = null;
      nextTickAt = null;
      // Let the tick in flight land first: a record cut halfway through a tick
      // would carry beats the director never saw.
      await settled;
      return finish(reason, "aborted");
    },

    finished(): Promise<SessionRecord> {
      return finishedPromise;
    },

    whenSettled(): Promise<void> {
      return settled;
    },
  };
}
