import {
  agentToolCalls,
  resolvePerson,
  type Beat,
  type BeatAdaptation,
  type BeatBody,
  type BeatFired,
  type ByTwin,
  type Criterion,
  type EpisodeSpec,
  type InjectedRef,
  type PersonRef,
  type TickRecord,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinName,
  type TwinSnapshot,
  type WorldSeed,
} from "@sonata/core";
import {
  escalationsFromTicks,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "@sonata/judge/checklist";
import type { Director } from "./director";
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

// ---------------------------------------------------------------------------
// ADAPTIVE WORDING.
//
// `ce-b10` fires at t12 and has the client say he has had nothing since nine
// o'clock. It says that whether or not the agent answered him at t2, and a
// 3-point `must` then grades the agent on its reply to that accusation: the world
// is factually wrong about the agent and the agent pays for it.
//
// The fix is NOT to cancel the beat. The beat still fires, at t12, in every run —
// that is the comparability property and it does not bend. What changes is the
// sentence, and only when CODE can show the agent already acted.
//
// Four rules hold this together, and every one of them exists because the obvious
// version of this feature breaks something:
//
//   - THE CONDITION IS THE SCORER'S. It is answered by `runChecklist` and the same
//     fact providers that grade the day. A second definition of "replied" here
//     would eventually disagree with the checklist, and the report would say "he
//     escalated about your silence" next to "replied ✓ pass".
//   - IT IS DECIDED IN CODE. No model, no dice. Same run in, same wording out.
//   - EVERY EVALUATION IS RECORDED, on the tick, in words: what was asked, what it
//     saw, what was concluded. Two runs stay diffable and a rewrite stays
//     explainable after the fact.
//   - IT FAILS TOWARD THE SCRIPT. Undecidable condition, no rewriter, a provider
//     that timed out, a rewrite that lost a required fact — all of them fire the
//     authored text. Never silence, never half a beat.
// ---------------------------------------------------------------------------

/**
 * The one field of a beat that is a person's own WORDING, as opposed to the facts
 * of what happened. Null for the kinds that have none.
 *
 * Two kinds and deliberately no more. An email body and a Slack message are
 * somebody talking, and talking is the thing that can be said differently to the
 * same effect. The rest of what a beat can do is not: a reaction is one emoji; an
 * invitation, a move and a cancellation are a time, a guest list and an event id,
 * and a model asked to reword those would be rewording the day's FACTS — which is
 * exactly what must stay fixed across runs.
 *
 * A subject line is excluded for the same reason. `gmail:replied_in_thread` falls
 * back to matching a reply by its subject when the twin does not log the thread
 * id, so a reworded subject is a scoring change dressed as a wording change.
 */
export function beatWords(body: BeatBody): string | null {
  if (body.twin === "gmail" && body.kind === "email") return body.payload.body;
  if (body.twin === "slack" && body.kind === "message") return body.payload.text;
  return null;
}

/** The same beat with new wording and everything else — id, ref, tick — untouched. */
export function withBeatWords(beat: Beat, words: string): Beat {
  if (beat.twin === "gmail" && beat.kind === "email") {
    return { ...beat, payload: { ...beat.payload, body: words } };
  }
  if (beat.twin === "slack" && beat.kind === "message") {
    return { ...beat, payload: { ...beat.payload, text: words } };
  }
  return beat;
}

/** Whose words these are. Only the two kinds `beatWords` admits ever reach here. */
function beatAuthor(body: BeatBody): PersonRef | null {
  if (body.twin === "gmail" && body.kind === "email") return body.payload.from;
  if (body.twin === "slack" && body.kind === "message") return body.payload.from;
  return null;
}

/** Case folded and whitespace collapsed, so a line break cannot lose a fact. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Which of `facts` the text does not carry — empty when they all survived.
 *
 * Substring matching, which is crude and is the right crudeness here: the facts
 * are literals an author copied out of their own beat ("£40k credit", "15:00"),
 * and the question is only whether the rewrite still says them. Anything cleverer
 * would be a judgement, and a judgement is what this check exists to avoid.
 *
 * `shownText` in @sonata/core's `runTruncation` is the fairness BACKSTOP for a
 * fact the agent was never told, and it keeps working untouched. This is
 * prevention in front of it, and the two are not the same thing: `shownText`
 * gathers the AUTHORED payload of every beat that landed, so a rewrite that
 * silently dropped the credit amount would still be counted as having shown it.
 * That is precisely the hole this closes, one step earlier.
 */
export function missingFacts(text: string, facts: readonly string[]): string[] {
  const hay = flat(text);
  return facts.filter((f) => f.trim() && !hay.includes(flat(f)));
}

/** Everything the world needs to decide, and then write, one tick's rewordings. */
export interface AdaptDeps {
  spec: EpisodeSpec;
  /**
   * The world's writer. A director without `rewrite` — every hand-rolled stub, and
   * any caller that predates this — leaves every beat exactly as authored.
   */
  director: Pick<Director, "rewrite">;
  adapters: ByTwin<TwinAdapter>;
  /** Each twin's snapshot from before tick 0: the checkers' `before` half. */
  before: ByTwin<TwinSnapshot>;
  /** Every audit row read so far this run, ascending. */
  audit: TwinAuditRow[];
  /** The run so far — the checkers read refs, prose and escalations off it. */
  ticks: TickRecord[];
  tick: number;
  simTimeLabel: string;
}

export interface BeatsAdapted {
  /** The tick's beats, in author order, some of them reworded. */
  beats: Beat[];
  /** One line per adaptive beat, for `TickRecord.notes`. */
  notes: string[];
}

/**
 * This tick's beats, reworded where the agent has already acted.
 *
 * Returns the input untouched, having read nothing and called nothing, when no
 * beat on this tick is adaptive — which is every beat in every scenario shipped
 * today. That early return is the "costs nothing extra" guarantee, and it is here
 * rather than at each call site so neither loop can forget it.
 */
export async function adaptBeats(due: Beat[], deps: AdaptDeps): Promise<BeatsAdapted> {
  if (!due.some((b) => b.adapt)) return { beats: due, notes: [] };

  const snapshots = await afterSnapshots(due, deps);
  const beats: Beat[] = [];
  const notes: string[] = [];
  // Sequential. Two adaptive beats on one tick is rare, the snapshots are taken
  // once above and shared, and a stable note order is worth more than the second
  // it saves.
  for (const beat of due) {
    if (!beat.adapt) {
      beats.push(beat);
      continue;
    }
    const outcome = await adaptOne(beat, beat.adapt, deps, snapshots);
    beats.push(outcome.beat);
    notes.push(outcome.note);
  }
  return { beats, notes };
}

type Snapshots = ByTwin<{ before: TwinSnapshot; after: TwinSnapshot }>;

/**
 * A snapshot of each surface an adaptive condition asks about, paired with the
 * one taken before tick 0.
 *
 * The checkers need both halves — a reply is a thread that grew — and the run
 * holds only the `before`. Taking the `after` here is the one read this feature
 * adds, and it is bought only on ticks that have an adaptive beat: `runEpisode`
 * declines to snapshot three twins every tick for `stopWhenAllMustPass` for
 * exactly this reason, and that reasoning still stands for every other tick.
 *
 * A twin that cannot be read yields no pair, the provider answers "no snapshot in
 * this run", and the beat fires as authored. Failing the day over it would trade a
 * wrong sentence for a lost afternoon.
 */
async function afterSnapshots(due: Beat[], deps: AdaptDeps): Promise<Snapshots> {
  const wanted = new Set<TwinName>();
  for (const beat of due) {
    const twin = beat.adapt?.when.twin;
    if (!twin) continue;
    if (twin === "any") for (const name of Object.keys(deps.adapters) as TwinName[]) wanted.add(name);
    else wanted.add(twin);
  }

  const out: Snapshots = {};
  for (const name of wanted) {
    const adapter = deps.adapters[name];
    const before = deps.before[name];
    if (!adapter || !before) continue;
    try {
      out[name] = { before, after: await adapter.snapshot() };
    } catch {
      // Unreadable is undecidable, and undecidable fires the script.
    }
  }
  return out;
}

/** What the condition concluded, in the three answers a checker actually has. */
type AdaptVerdict = "acted" | "not-yet" | "undecided";

/**
 * Put the beat's condition to the judge's own checklist, as of right now.
 *
 * `truncation` is deliberately NOT supplied. Mid-day every beat still to come
 * looks exactly like a beat that never fired, so `harnessDefectFor` would refuse
 * the condition on the grounds that the afternoon has not happened yet — true,
 * and useless. Everything else the checklist wants is a pure read over the ticks
 * so far, which is why this can run inside the loop at all.
 */
function checkCondition(
  beat: Beat,
  adapt: BeatAdaptation,
  deps: AdaptDeps,
  snapshots: Snapshots,
): { verdict: AdaptVerdict; evidence: string } {
  const { when } = adapt;
  const criterion: Criterion = {
    // Namespaced by the beat. A `Fact` minted here can never be mistaken for one
    // of the day's own criteria, in a note or in anything that reads one.
    id: `adapt:${beat.id}`,
    description: when.description,
    twin: when.twin,
    kind: when.kind,
    ...(when.ref === undefined ? {} : { ref: when.ref }),
    ...(when.target === undefined ? {} : { target: when.target }),
    ...(when.expect === undefined ? {} : { expect: when.expect }),
    ...(when.before === undefined ? {} : { before: when.before }),
    // Never scored, and shaped so it cannot be: see `BeatCondition`.
    weight: 0,
    severity: "should",
  };

  const { results } = runChecklist({
    criteria: [criterion],
    world: deps.spec.world,
    refs: refsFromTicks(deps.ticks),
    snapshots,
    audit: deps.audit,
    escalations: escalationsFromTicks(deps.ticks),
    written: writtenFromTicks(deps.ticks),
    agentActed: agentToolCalls(deps.ticks) > 0,
    tickOf: tickIndexer(deps.ticks),
  });

  const result = results[0];
  if (!result) {
    return {
      verdict: "undecided",
      evidence:
        `no checker answered "${when.twin}/${when.kind}" — that kind is the judge's, and the ` +
        "judge does not run mid-day",
    };
  }
  const evidence = result.evidence ?? "(the checker recorded no evidence)";
  if (result.status === "passed") return { verdict: "acted", evidence };
  if (result.status === "failed") return { verdict: "not-yet", evidence };
  return { verdict: "undecided", evidence };
}

/** The head of every note this beat produces, so two runs diff line for line. */
function adaptHead(beat: Beat, adapt: BeatAdaptation): string {
  const { when } = adapt;
  const about = when.ref ? ` on "${when.ref}"` : when.expect ? ` for "${when.expect}"` : "";
  return `beat ${beat.id} adapt: asked ${when.twin}/${when.kind}${about} — ${when.description}`;
}

async function adaptOne(
  beat: Beat,
  adapt: BeatAdaptation,
  deps: AdaptDeps,
  snapshots: Snapshots,
): Promise<{ beat: Beat; note: string }> {
  const head = adaptHead(beat, adapt);
  const authored = beatWords(beat);
  const author = beatAuthor(beat);
  if (authored === null || author === null) {
    return {
      beat,
      note: `${head} → not attempted: a ${beat.twin} ${beat.kind} carries no wording to adapt. Fired as authored.`,
    };
  }

  const check = checkCondition(beat, adapt, deps, snapshots);
  if (check.verdict !== "acted") {
    const said = check.verdict === "not-yet" ? "the agent has not" : "undecidable";
    return { beat, note: `${head} → ${said}: ${check.evidence}. Fired as authored.` };
  }

  const who = nameOf(deps.spec.world, author);
  if (!deps.director.rewrite) {
    return {
      beat,
      note: `${head} → the agent has: ${check.evidence}. No rewriter in this run, so it fired as authored.`,
    };
  }

  const outcome = await deps.director.rewrite({
    beatId: beat.id,
    personId: author,
    twin: beat.twin,
    authored,
    facts: adapt.facts,
    saw: check.evidence,
    sawOn: adapt.when.twin,
    wrote: writtenFromTicks(deps.ticks),
    tick: deps.tick,
    simTimeLabel: deps.simTimeLabel,
  });

  if (!outcome.words) {
    return {
      beat,
      note: `${head} → the agent has: ${check.evidence}. The rewrite failed (${outcome.error ?? "no words came back"}), so it fired as authored.`,
    };
  }

  const lost = missingFacts(outcome.words, adapt.facts);
  if (lost.length) {
    // The one thing a rewrite may never do. This beat may be the only place the
    // day ever says the number every downstream criterion assumes the agent was
    // told, so a wording that lost it is discarded whole rather than patched.
    return {
      beat,
      note:
        `${head} → the agent has: ${check.evidence}. ${who}'s rewrite dropped ` +
        `${lost.map((f) => `"${f}"`).join(", ")}, so it fired as authored.`,
    };
  }

  return {
    beat: withBeatWords(beat, outcome.words),
    note:
      `${head} → the agent has: ${check.evidence}. Reworded in character as ${who}, ` +
      `carrying ${adapt.facts.length} required fact(s); same tick, same thread, same ref.`,
  };
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
