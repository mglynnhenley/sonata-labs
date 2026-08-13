import {
  episodeTwins,
  plannedTicks,
  type AgentStep,
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
import { writtenFromTicks } from "@sonata/judge/checklist";
import { createClock, type SimClock } from "./clock";
import {
  adaptBeats,
  beatWords,
  createRefRegistry,
  fireBeats,
  NO_ASSESSMENTS,
  injectBody,
  missingFacts,
  scheduleBeats,
  summarizeBody,
  unreachableBeats,
  type RefRegistry,
} from "./beats";
import {
  auditRefName,
  createDirector,
  type DeltaDetail,
  type Director,
  type UpcomingBeat,
} from "./director";
import { recentHistory, tickDigest } from "./timeline";
import { attributeActions, newTrace, pairRowsToSteps, traceCost, withTrace } from "./trace";
import { errorMessage } from "./http";
import { byTwin } from "./adapters";
import type { Agent, AgentContext } from "./agent";

// THE TICK LOOP.
//
// One simulated workday, one tick at a time, in an order that is not negotiable:
//
//   1. BEATS. What the day was always going to do, fired from the script.
//   2. DIRECTOR. What the world does back, having seen what the agent did in the
//      PREVIOUS tick (read out of each twin's audit log), the prose it wrote in
//      doing it (`detailFor`, since the log carries none), and this tick's beats.
//      One model call per person the world casts — often none — never one call
//      per tick; see `castTick`.
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
  // An adaptive beat that can never adapt. All of these are silent at runtime —
  // the beat just fires as authored, forever, and the note explaining why is
  // buried in one tick — so they are said once, up front, where an author looks.
  // Silently-always-authored is the failure that looks exactly like working.
  const created = new Set(spec.beats.map((b) => b.ref).filter((r): r is string => Boolean(r)));
  for (const beat of spec.beats) {
    const adapt = beat.adapt;
    if (!adapt) continue;
    // A condition pointing at a beat nothing in this spec creates. `danglingRefs`
    // in @sonata/core reads payloads and criteria and does not look in here, so
    // nothing else catches it: the checklist refuses the condition as a harness
    // defect on every tick of every run, and the beat never adapts once.
    const on = adapt.when.ref;
    if (on && !created.has(on)) {
      notes.push(
        `beat "${beat.id}" adapts on beat ref "${on}", which no beat in this spec creates — the ` +
          `condition can never be settled, so this beat will always fire as authored`,
      );
    }
    const words = beatWords(beat);
    if (words === null) {
      notes.push(
        `beat "${beat.id}" is marked adaptive, but a ${beat.twin} ${beat.kind} carries no wording ` +
          `to adapt, so it will always fire exactly as authored`,
      );
      continue;
    }
    // A fact the beat does not itself say cannot survive a rewrite, because it was
    // never there: every rewrite would be discarded and the adaptation would be
    // dead weight paid for once a run.
    const absent = missingFacts(words, adapt.facts);
    if (absent.length) {
      notes.push(
        `beat "${beat.id}" requires ${absent.map((f) => `"${f}"`).join(", ")} to survive a ` +
          `rewrite, but its own authored text does not say ${absent.length === 1 ? "it" : "them"} — ` +
          `no rewrite can ever pass, so this beat will always fire as authored`,
      );
    }
    notes.push(...unprotectedPhrases(beat, words, adapt.facts, spec));
  }
  return notes;
}

/**
 * Phrases a `mentions` criterion demands of the AGENT that only this beat's
 * rewritable wording ever says, and that the beat does not declare as facts.
 *
 * The one way scoring can still be moved by a rewrite, and it has to be said out
 * loud because nothing downstream can see it. `mentions` asks whether the agent
 * wrote a phrase; the agent can only write a phrase somebody told it; and if the
 * only sentence in the day carrying it is one a model is about to reword, a
 * dropped phrase fails the criterion. The usual backstop does not fire either —
 * `runTruncation.shownText` is built from the AUTHORED payloads, so it reports the
 * phrase as shown whatever actually went out (see `missingFacts` in ./beats).
 *
 * Adding the phrase to `adapt.facts` closes it completely: a rewrite that loses a
 * declared fact is discarded and the authored words go out instead.
 *
 * Deliberately narrow. Only `mentions` is checked, because that is the only kind
 * whose `expect` is a phrase the agent has to have been told rather than a channel,
 * a label or an event title. And only when NO other beat's wording says it, so a
 * fact the day repeats elsewhere is not reported as at risk.
 */
function unprotectedPhrases(
  beat: EpisodeSpec["beats"][number],
  words: string,
  facts: string[],
  spec: EpisodeSpec,
): string[] {
  const elsewhere = spec.beats
    .filter((b) => b.id !== beat.id)
    .map((b) => beatWords(b) ?? "")
    .join("\n");
  const notes: string[] = [];
  for (const c of spec.success.checklist) {
    const phrase = c.expect;
    if (c.kind !== "mentions" || !phrase?.trim()) continue;
    // Said here, said nowhere else, and not already guaranteed by a declared fact
    // that contains it — "£40k" is safe the moment "the £40k credit" must survive.
    if (missingFacts(words, [phrase]).length) continue;
    if (!missingFacts(elsewhere, [phrase]).length) continue;
    if (facts.some((f) => !missingFacts(f, [phrase]).length)) continue;
    notes.push(
      `criterion "${c.id}" is scored on the agent repeating "${phrase}", and the only place the ` +
        `day says it is beat "${beat.id}", whose wording adapts. Add it to that beat's ` +
        `\`adapt.facts\` or a rewrite can drop it and the agent will be failed for not saying ` +
        `something it was never told`,
    );
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
  /**
   * Each twin's snapshot from before tick 0. Read only by an adaptive beat, whose
   * condition is settled by the judge's checkers and so needs both halves of a
   * diff; nothing else in the tick looks at it.
   */
  before: ByTwin<TwinSnapshot>;
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

/**
 * One line per beat still to come, so the world does not pre-empt the script.
 *
 * Carries the twin as well as the line, because each character is only shown the
 * surfaces they are on: a client with no Slack account must not be handed the
 * text of a Slack beat, not even as something to avoid pre-empting.
 */
function upcomingLines(deps: TickDeps, after: number): UpcomingBeat[] {
  return deps.spec.beats
    .filter((b) => b.tick > after && b.tick < deps.clock.ticks)
    .sort((a, b) => a.tick - b.tick)
    .map((b) => ({
      twin: b.twin,
      line: `${deps.clock.labelAt(b.tick)} — ${summarizeBody(b, deps.spec.world)}`,
    }));
}

export interface TickInput {
  tick: number;
  ticks: TickRecord[];
  /** Highest audit row id already attributed, per twin. */
  cursors: Map<TwinName, number>;
  /**
   * Every audit row read so far this run, ascending — appended to as ticks read
   * their deltas.
   *
   * Carried rather than derived because it cannot be derived: a `TickRecord` holds
   * the agent's STEPS and no audit rows, and an adaptive beat's condition goes to
   * the judge's own checkers, which read the log. `runEpisode` gathers the same
   * rows again at the end for the artifact; that pass runs off `auditSince(0)` and
   * is untouched by this one.
   */
  audit: TwinAuditRow[];
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

/**
 * What one of the agent's steps actually wrote, through the judge's own extractor.
 *
 * `writtenFromTicks` already answers "which tool arguments hold prose the agent
 * authored" — its comment is the reason it exists: "the tool arguments are the
 * only place a sent email's body survives" — and the judge scores `mentions`
 * criteria off exactly that answer. A second copy of the field list here would
 * drift the first time a tool grew a field, and the world and the scorer would
 * then disagree about what the agent said. So the step is handed to the existing
 * function as a one-step tick rather than re-derived.
 */
function proseOf(step: AgentStep, tick: TickRecord): string {
  const [written] = writtenFromTicks([{ ...tick, agentSteps: [step] }]);
  return written?.text ?? "";
}

/**
 * What the harness knows about this tick's deltas beyond the audit rows: which
 * agent step wrote each one, and what that step said.
 *
 * The deltas read at the top of tick N are the rows the agent's tools wrote
 * during tick N-1 — beats and director events go in through the twins' unaudited
 * sandbox routes precisely so that stays true — so the previous tick's record
 * holds the steps that produced them, and `pairRowsToSteps` says which is which.
 *
 * Keyed by `pairRowsToSteps`'s own twin-qualified key and never re-keyed: a tick
 * in which the agent both emails and posts to Slack holds gmail row 1 and slack
 * row 1 at once.
 */
function detailFor(prev: TickRecord | undefined, deltas: TwinAuditRow[]): Map<string, DeltaDetail> {
  const detail = new Map<string, DeltaDetail>();
  if (!prev) return detail;
  for (const [key, step] of pairRowsToSteps(prev.agentSteps, deltas)) {
    const prose = proseOf(step, prev);
    detail.set(key, { seq: step.seq, ...(prose ? { prose } : {}) });
  }
  return detail;
}

export async function runTick(deps: TickDeps, input: TickInput): Promise<TickRecord> {
  const { tick } = input;
  const startedAt = deps.now();
  const simTimeISO = deps.clock.isoAt(tick);
  const notes: string[] = [];

  const schedule = scheduleBeats(deps.spec.beats);
  const due = schedule.at(tick);

  // 0. ADAPTIVE WORDING, and only on a tick that has some.
  //
  // This loop fires beats BEFORE it reads the audit log, so at tick T the world
  // knows what the agent did up to tick T-2 — fine for the director, which reacts
  // a tick late on purpose, and wrong for a beat, which would escalate about a
  // silence the agent broke fifteen minutes ago. So the deltas are read FIRST
  // here, and the rows go on to be the same rows the director then sees.
  //
  // Guarded on `some(b.adapt)` so that a tick with no adaptive beat — every tick
  // of every scenario shipped today — takes byte-for-byte the path it took before
  // this existed: one delta read, in the same place, and no snapshot.
  const adaptive = due.some((b) => b.adapt);
  const early = adaptive ? await readDeltas(deps, input.cursors) : [];
  input.audit.push(...early);

  const adapted = adaptive
    ? await adaptBeats(due, {
        spec: deps.spec,
        director: deps.director,
        adapters: deps.used,
        before: deps.before,
        audit: input.audit,
        ticks: input.ticks,
        tick,
        simTimeLabel: deps.clock.labelAt(tick),
      })
    : { beats: due, notes: [], assessments: NO_ASSESSMENTS };
  notes.push(...adapted.notes);

  // 1. Beats.
  const beatsFired: BeatFired[] = await fireBeats(
    adapted.beats,
    simTimeISO,
    { adapters: deps.used, world: deps.spec.world, refs: deps.refs },
    adapted.assessments,
  );

  // 2. Director. The deltas are what the agent did in the PREVIOUS tick — the
  // audit rows written since the last read — which is exactly what a coworker
  // would have seen by now. On an adaptive tick most of them were already read
  // above; the cursor moved with them, so the second read only picks up anything
  // that landed while the beats were being reworded, and the merged list is the
  // one the director would have been handed either way.
  const fresh = await readDeltas(deps, input.cursors);
  input.audit.push(...fresh);
  const deltas = early.length ? [...early, ...fresh].sort((a, b) => a.id - b.id) : fresh;
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
    deltaDetail: detailFor(input.ticks[input.ticks.length - 1], deltas),
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

  // Filled once, from the `before` snapshot below, and read only by an adaptive
  // beat. Held out here rather than passed around so `deps` can be built in one
  // place while the snapshot it needs is taken inside the try, where a twin that
  // refuses is a failed run rather than a thrown constructor.
  const before: ByTwin<TwinSnapshot> = {};

  const deps: TickDeps = {
    spec,
    clock,
    used,
    refs,
    director,
    agent: opts.agent,
    historyLimit: opts.historyLimit ?? 40,
    now,
    before,
  };

  const cursors = new Map<TwinName, number>();
  const allAudit: TwinAuditRow[] = [];
  /** Rows read tick by tick, for an adaptive beat's condition. See `TickInput`. */
  const readSoFar: TwinAuditRow[] = [];
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
    Object.assign(before, await snapshotAll(used));

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
        const record = await runTick(deps, { tick, ticks: run.ticks, cursors, audit: readSoFar });
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
