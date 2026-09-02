import type { BeatKind, CriterionKind, TwinName } from "@sonata/core";

// What makes a success criterion CHECKABLE, in one place.
//
// A criterion is a promise that something can be looked up after the run: a
// reply on a named thread, a post in a named channel, a mail to a named person.
// The checkers in @sonata/judge answer exactly those questions and nothing
// wider — hand one a criterion that names no thread and it can only report that
// it could not be checked, which is not a pass, not a failure, and not the
// agent's fault. A whole checklist of those is how a run where the agent sent
// nothing all day was stamped "Passed, 100%": every `must` was undecidable, one
// `should` was decided, and 1/1 is 100%.
//
// So the rule this module exists to enforce: a criterion that cannot bind must
// not be authorable. `bindCriteria` is run over generated AND hand-written days
// before either is stored, and everything that does not bind is named, with the
// reason, rather than saved to be discovered hours later on a shared report.
//
// The rules below are the checkers' requirements restated as authoring law. They
// are deliberately a little stricter than the checkers: the checker's job is to
// salvage what it can from whatever it is handed, and this file's job is to make
// sure it is never handed anything it would have to salvage.
//
// One more thing is authored in this vocabulary, and so is gated here rather than
// somewhere of its own: the condition on an ADAPTIVE BEAT — "reword this chaser
// if the agent has already replied". `BeatCondition` in @sonata/core is a
// `Criterion` with the score taken off, precisely so that the world's idea of
// "replied" and the scorer's cannot come apart. See `bindAdaptation`.

// ---------------------------------------------------------------------------
// The shape both producers write — the model in the platform's draft flow, and
// the hand-written templates. `PersonRef`-shaped fields are cast NAMES here and
// ids only after assembly, so binding takes a resolver rather than a WorldSeed.
// ---------------------------------------------------------------------------

export interface DraftCriterion {
  /** Written as the outcome, not the action: "the client got an answer before noon". */
  description: string;
  twin: TwinName | "any";
  kind: CriterionKind;
  /** The beat this is about, by its `ref`. */
  ref?: string;
  /**
   * The deadline: a beat's `ref`, or an absolute tick as "t12". See
   * `Criterion.before` in @sonata/core for why it is one field and not two.
   */
  before?: string;
  /** The label, channel, phrase or title the check looks for. */
  expect?: string;
  /** Who the action should have reached. A cast name, or a person id. */
  target?: string;
  severity: "must" | "should";
  weight?: number;
}

/** A beat that survived assembly and can therefore be pointed at. */
export interface BindableBeat {
  ref: string;
  twin: TwinName;
  kind: BeatKind;
  /**
   * The tick it fires on. Optional only so a caller that predates ordering still
   * compiles: without it the deadline checks below can still refuse a `before`
   * that names nothing, but not one that names a moment EARLIER than the beat the
   * criterion is about — which is the unsatisfiable case worth catching. Pass it.
   */
  tick?: number;
}

export interface BindingContext {
  /** Only beats that made it into the spec: a dropped beat cannot be named. */
  beats: BindableBeat[];
  /** Channel names in the world, with or without a leading '#'. */
  channels: string[];
  /** Cast lookup by name or id. Returns the canonical `Person.id`. */
  person(ref: string): string | undefined;
  /**
   * Does a deterministic checker exist for this pair? Passed in rather than
   * imported so this package stays free of @sonata/judge — and so the answer is
   * always the judge's own provider table, not a copy of it that can rot.
   */
  hasChecker(twin: TwinName | "any", kind: CriterionKind): boolean;
}

/** A criterion that will not be checkable, and the sentence that says why. */
export interface UnboundCriterion {
  description: string;
  twin: TwinName | "any";
  kind: CriterionKind;
  severity: "must" | "should";
  /** Reads as the second half of "…cannot be checked because …". */
  why: string;
}

export interface BindingReport {
  /** Normalized and checkable: channel names, person ids, trimmed refs. */
  bound: DraftCriterion[];
  unbound: UnboundCriterion[];
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** What the second argument of a check is, and therefore how it is validated. */
type ExpectKind = "channel" | "label" | "phrase" | "title";

interface Rule {
  /** Beat kinds whose artefact this criterion can be checked against. */
  refBeatKinds?: BeatKind[];
  /** The criterion must name someone in the cast. */
  needsPerson?: boolean;
  needsExpect?: ExpectKind;
  /** Named for the prompt: "a reply on the thread beat `x` started". */
  names: string;
  /**
   * Why this pair's checker settles it without ever recording WHEN — set only on
   * the pairs where that is true of every route through the check.
   *
   * These are decided from the state at the end of the day: the labels a thread
   * is carrying, whether it is out of the inbox, the events on the calendar. None
   * of those carries the moment the agent made it so, so a `before` on one is
   * undecidable in EVERY run — the check passes, the ordering half cannot be
   * settled, and the row leaves the score. On a `must` that is not a lost row but
   * a lost day: `verdictOutcome` in @sonata/core returns `inconclusive` whenever a
   * decisive criterion is undecided, so the scenario would come back ungraded for
   * every model, forever, while looking like it was working. Same reason as
   * `NO_ORDERING` below, arrived at from the other end.
   *
   * Restating the checkers' behaviour, like every other rule in this table — so
   * when a provider in @sonata/judge learns to date its verdict (Slack's snapshot
   * already carries a `ts` it does not convert), delete its entry here.
   */
  undated?: string;
}

/**
 * Every (twin, kind) pair a day may be authored with, and what each one has to
 * name. A pair that is absent is not authorable — see `WHY_NOT` for the four
 * that are absent on purpose.
 */
const RULES: Partial<Record<string, Rule>> = {
  "gmail/replied": {
    refBeatKinds: ["email"],
    names: "the email beat whose thread the reply must land on",
  },
  "gmail/sent": { needsPerson: true, names: "the person who must receive a new email" },
  "gmail/labelled": {
    refBeatKinds: ["email"],
    needsExpect: "label",
    names: "the email beat, and the label its thread must carry",
    undated: "it reads the labels the thread is carrying at the end of the day, and a label on a thread does not say when it went on",
  },
  "gmail/archived": {
    refBeatKinds: ["email"],
    names: "the email beat whose thread must leave the inbox",
    undated: "it reads whether the thread is out of the inbox at the end of the day, which says nothing about when it left",
  },
  "gmail/mentions": { needsExpect: "phrase", names: "the phrase the agent must write in an email" },
  "slack/posted": { needsExpect: "channel", names: "the channel the agent must post in" },
  "slack/sent": { needsPerson: true, names: "the person who must receive a DM" },
  "slack/replied": {
    refBeatKinds: ["message"],
    names: "the Slack message beat whose thread the reply must land in",
    undated: "it reads the thread out of the end-of-day snapshot and does not date the reply it finds there",
  },
  "slack/mentions": { needsExpect: "phrase", names: "the phrase the agent must write in Slack" },
  "calendar/scheduled": {
    needsExpect: "title",
    names: "words from the title of the meeting that must exist afterwards",
    undated: "it reads the events on the calendar at the end of the day, and when a meeting STARTS is not when it was booked",
  },
  "calendar/mentions": {
    needsExpect: "phrase",
    names: "the phrase the agent must write on an event",
  },
  "any/mentions": { needsExpect: "phrase", names: "the phrase the agent must write somewhere" },
  "any/no-escalation": { names: "nothing — the run itself settles it" },
  // `any` is a claim about the day rather than about a surface — "the client got
  // an answer" is satisfied by an email or by a DM, and the judge puts exactly
  // that question to every surface that can answer it. So each one needs what
  // its surfaces need: the beat, the person, the channel, the title.
  "any/replied": {
    refBeatKinds: ["email", "message"],
    names: "the beat whose thread must get a reply, on whichever surface it is on",
  },
  "any/sent": { needsPerson: true, names: "the person who must be reached, by email or DM" },
  "any/posted": { needsExpect: "channel", names: "the channel the agent must post in" },
  // The `any` versions of the three end-state checks reach exactly one surface —
  // `acrossSurfaces` asks only the twin the criterion's own beat is on, and only
  // the calendar implements `scheduled` — so they inherit that surface's blindness
  // to when, and its refusal of a deadline with it.
  "any/labelled": {
    refBeatKinds: ["email"],
    needsExpect: "label",
    names: "the email beat, and the label its thread must carry",
    undated: "it reads the labels the thread is carrying at the end of the day, and a label on a thread does not say when it went on",
  },
  "any/archived": {
    refBeatKinds: ["email"],
    names: "the email beat whose thread must leave the inbox",
    undated: "it reads whether the thread is out of the inbox at the end of the day, which says nothing about when it left",
  },
  "any/scheduled": {
    needsExpect: "title",
    names: "words from the title of the meeting that must exist afterwards",
    undated: "it reads the events on the calendar at the end of the day, and when a meeting STARTS is not when it was booked",
  },
  "gmail/judged": { names: "nothing — the judge answers it in prose" },
  "slack/judged": { names: "nothing — the judge answers it in prose" },
  "calendar/judged": { names: "nothing — the judge answers it in prose" },
  "any/judged": { names: "nothing — the judge answers it in prose" },
};

/**
 * Kinds an authored day may not use at all, and the honest reason.
 *
 * All three are decided against the `before` snapshot, which is taken after the
 * world is seeded and BEFORE the first beat fires. A criterion can only name a
 * beat, and every beat lands after that snapshot — so the thing it names was
 * never in the "before" the checker diffs against, and the answer is always
 * "cannot tell". They are checkable claims about the company's backlog; there is
 * no authoring vocabulary that reaches the backlog, so they are not authorable.
 */
const WHY_NOT: Partial<Record<CriterionKind, string>> = {
  untouched:
    "`untouched` is decided against the snapshot taken before the day starts, and a beat lands " +
    "after it — so a beat this day creates can never be shown to have been left alone",
  moved:
    "`moved` compares an event against the calendar as it was before the day started, and an " +
    "event a beat creates during the day was not on it",
  cancelled:
    "`cancelled` compares an event against the calendar as it was before the day started, and an " +
    "event a beat creates during the day was not on it",
};

function key(twin: TwinName | "any", kind: CriterionKind): string {
  return `${twin}/${kind}`;
}

function str(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** "#ops" and "ops" are the same channel; specs write both. */
function channelName(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function words(value: string): number {
  return value.trim().split(/\s+/).length;
}

/**
 * The second argument of the check, wherever the author put it.
 *
 * A channel is the one `expect` the judge also reads off `target` — see
 * `slack:posted_in_channel`, which takes `expect ?? target`. Both producers write
 * it both ways, and rejecting the `target` spelling would cost a criterion that
 * binds perfectly well for the sake of a field name.
 */
function expectValue(c: DraftCriterion, rule: Rule): string | undefined {
  const expect = str(c.expect);
  if (expect) return expect;
  return rule.needsExpect === "channel" ? str(c.target) : undefined;
}

/**
 * A phrase is checked by substring match, in order, over what the agent wrote.
 *
 * So the only phrases that can ever match are the ones a person would type
 * verbatim: a time, an amount, a reference, a two- or three-word name. Prose
 * never matches, and neither does a keyword list — a generated criterion asked
 * for "structural facade mechanical roof electrical" as a `must`, which no agent
 * writing English would ever produce in that order. Both are unpassable criteria
 * dressed as checkable ones, and an unpassable `must` is as false a report as an
 * undecidable one: it fails a run for a sentence nobody could have written.
 */
const PHRASE_MAX_WORDS = 4;

function phraseProblem(value: string, what: string): string | undefined {
  if (value.length < 3) return `its ${what} "${value}" is too short to match anything specific`;
  if (words(value) > PHRASE_MAX_WORDS || /[.!?]/.test(value)) {
    return (
      `its ${what} is prose, not a phrase ("${value}") — it is matched as a substring of what the ` +
      `agent wrote, so it must be at most ${PHRASE_MAX_WORDS} words that would appear verbatim`
    );
  }
  // Three or four bare lowercase words in a fixed order is a list of keywords,
  // not a thing anyone says. A named thing carries a capital, a digit or a
  // hyphen, and those are the phrases that actually turn up in a reply.
  if (words(value) > 2 && !/[A-Z0-9-]/.test(value)) {
    return (
      `its ${what} "${value}" is a string of ordinary words — matched as one substring, in that ` +
      `exact order, so nothing the agent writes will contain it. Use the distinctive part instead: ` +
      `a name, a number, a time, an amount`
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ordering. `before` is the only field on a criterion that names a SECOND moment,
// and the only one that can be unsatisfiable rather than merely unbindable: a
// deadline earlier than the thing it is supposed to follow fails every run of
// every model, for a reason nobody reading the report would guess at.
// ---------------------------------------------------------------------------

/** The absolute spelling of a deadline, matching @sonata/judge's `ABSOLUTE_TICK`. */
function absoluteTick(value: string): number | undefined {
  const m = /^t(\d+)$/i.exec(value);
  return m ? Number(m[1]) : undefined;
}

/**
 * Kinds a deadline may not be attached to, and why each one would be a lie.
 *
 * Both pass by NOTHING being found: an absence has no moment, so the checker has
 * no tick to compare and every pass would come back undecided. A criterion that
 * silently converts its own passes into unscored rows is worse than one that was
 * refused, because it looks like it is working.
 */
const NO_ORDERING: Partial<Record<CriterionKind, string>> = {
  "no-escalation":
    "`no-escalation` passes when the agent handed the job back to nobody, and a thing that never " +
    "happened has no moment to be early or late — a deadline on it would turn every pass into an " +
    "undecided row. Drop the `before`",
  judged:
    "`judged` is answered by the judge in prose, and the judge is never given a tick to compare — " +
    "a deadline on it would be stored and never read. Drop the `before`",
};

/** The pairs whose checker never records when — for the prompt, off the one table. */
const UNDATED_PAIRS: string[] = Object.entries(RULES)
  .filter(([, rule]) => rule?.undated)
  .map(([pair]) => pair);

/** Why this criterion's deadline could never be met, or undefined when it can. */
function orderingProblem(c: DraftCriterion, ctx: BindingContext, rule: Rule): string | undefined {
  const before = str(c.before);
  if (!before) return undefined;

  const forbidden = NO_ORDERING[c.kind];
  if (forbidden) return forbidden;

  if (rule.undated) {
    return (
      `\`${key(c.twin, c.kind)}\` is settled without a clock — ${rule.undated} — so a deadline on ` +
      `it could never be checked: the ordering half would come back unmeasured in every run, and ` +
      `one undecided \`must\` leaves the whole day ungraded. Put the \`before\` on a criterion ` +
      `whose check records when the agent acted — replied, sent, mentions — or drop it`
    );
  }

  const beat = ctx.beats.find((b) => b.ref === before);
  const tick = absoluteTick(before);

  // A beat whose ref is literally "t12". Refused here and only here: the checker
  // that reads this later knows the beats that FIRED and nothing else, so it would
  // read the word as a beat in a run that reached t12 and as a tick in a run that
  // did not — one spec, two meanings, decided by how far the day got.
  if (beat && tick !== undefined) {
    return (
      `its \`before\` is "${before}", which is both a beat in this day and an absolute tick — a ` +
      `checker knows only the beats that fired, so the same word would mean two different things ` +
      `in two runs of this one spec. Rename the beat, or name the other deadline`
    );
  }
  if (!beat && tick === undefined) {
    const available = ctx.beats.map((b) => b.ref).join(", ") || "none";
    return (
      `it must happen before "${before}", which is neither a beat in this day (beats with a ref: ` +
      `${available}) nor an absolute tick written as "t12"`
    );
  }

  const deadline = beat ? beat.tick : tick;
  const subject = rule.refBeatKinds ? ctx.beats.find((b) => b.ref === str(c.ref)) : undefined;
  if (deadline === undefined || subject?.tick === undefined) return undefined;

  // Beats fire at the top of a tick and the agent acts at the bottom of the same
  // one, so the earliest the agent can answer beat S is tick S — which leaves no
  // room at all when the deadline is S itself.
  if (subject.tick >= deadline) {
    return (
      `it must happen before ${beat ? `beat "${before}" (t${deadline})` : `t${deadline}`}, but the ` +
      `beat it is about ("${subject.ref}") does not fire until t${subject.tick}. The agent cannot ` +
      `answer something it has not been sent yet, so no run could ever satisfy this`
    );
  }
  return undefined;
}

/** Why this criterion cannot be checked, or undefined when it can. */
function problem(c: DraftCriterion, ctx: BindingContext): string | undefined {
  const forbidden = WHY_NOT[c.kind];
  if (forbidden) return forbidden;

  const rule = RULES[key(c.twin, c.kind)];
  if (!rule) {
    return (
      `no criterion of kind "${c.kind}" can be checked on ${c.twin} — pick a twin and kind that ` +
      `name the same surface`
    );
  }
  // The judge answers `judged` in prose; everything else needs a fact provider,
  // and the judge's own table is the authority on which ones exist.
  if (c.kind !== "judged" && !ctx.hasChecker(c.twin, c.kind)) {
    return `no deterministic checker exists for ${c.twin}/${c.kind}`;
  }

  if (rule.refBeatKinds) {
    const ref = str(c.ref);
    if (!ref) return `it names no beat ref, so there is nothing to look at — it must name ${rule.names}`;
    const beat = ctx.beats.find((b) => b.ref === ref);
    if (!beat) {
      const available = ctx.beats.map((b) => b.ref).join(", ") || "none";
      return `ref "${ref}" is not a beat in this day (beats with a ref: ${available})`;
    }
    // An `any` criterion is settled on the beat's OWN surface — the judge asks
    // only that one — so it may name a beat on any surface the rule allows. A
    // criterion filed under one twin may not reach across to another: an email
    // thread cannot be replied to in Slack.
    if (!rule.refBeatKinds.includes(beat.kind) || (c.twin !== "any" && beat.twin !== c.twin)) {
      return (
        `ref "${ref}" is a ${beat.twin}/${beat.kind} beat, which cannot carry a ` +
        `${c.twin}/${c.kind} check`
      );
    }
  }

  if (rule.needsPerson) {
    const target = str(c.target);
    if (!target) return "it names no recipient, so there is nobody to check the message reached";
    if (!ctx.person(target)) return `"${target}" is not in the cast, so no address can be resolved`;
  } else if (c.kind === "no-escalation" && str(c.target)) {
    // The run records what was said when the agent handed the job back, not who
    // it went to. "…and not to the client" is therefore a claim the artifact
    // cannot settle, and the checker says so — which is another undecided must.
    return (
      "`no-escalation` is decided from what the agent said, not who it said it to, so it cannot " +
      "be narrowed to one person — drop the target and claim only that the job was never handed back"
    );
  }

  const expect = expectValue(c, rule);
  if (rule.needsExpect) {
    if (!expect) return `it names no ${rule.needsExpect} in \`expect\` — ${rule.names}`;
    if (rule.needsExpect === "channel") {
      const known = ctx.channels.map(channelName);
      if (!known.includes(channelName(expect))) {
        return `#${channelName(expect)} is not a channel in this world (${known.map((c) => `#${c}`).join(", ")})`;
      }
    } else if (rule.needsExpect === "label") {
      if (expect.length > 40) return `its label "${expect}" is prose, not a label`;
    } else {
      const bad = phraseProblem(expect, rule.needsExpect);
      if (bad) return bad;
    }
  }

  const late = orderingProblem(c, ctx, rule);
  if (late) return late;

  if (!str(c.description)) return "it has no description, so nothing states what was being asked";
  return undefined;
}

/**
 * The criterion as it should be stored: trimmed, with ids and channel names
 * canonical. Fields the check does not read are dropped rather than rejected —
 * a stray `ref` on a `posted` criterion is noise, not an unanswerable claim, and
 * spending a regeneration on it would cost more days than it saves.
 */
function normalize(c: DraftCriterion, ctx: BindingContext): DraftCriterion {
  const rule = RULES[key(c.twin, c.kind)];
  const target = str(c.target);
  // A channel written as `target` is stored as `expect`, so the criterion the
  // judge reads names its channel in one field and only one.
  const expect = rule ? expectValue(c, rule) : str(c.expect);
  return {
    description: c.description.trim(),
    twin: c.twin,
    kind: c.kind,
    ...(rule?.refBeatKinds && str(c.ref) ? { ref: str(c.ref)! } : {}),
    // Kept for every kind, unlike `ref`/`expect`/`target`, because a deadline is
    // not the second argument of one check — it is a claim about any of them, and
    // `orderingProblem` has already refused it on the two kinds that cannot carry
    // one. Dropping it here is how the feature would come back "it never fired".
    ...(str(c.before) ? { before: str(c.before)! } : {}),
    ...(rule?.needsExpect && expect
      ? { expect: rule.needsExpect === "channel" ? channelName(expect) : expect }
      : {}),
    ...(rule?.needsPerson && target ? { target: ctx.person(target) ?? target } : {}),
    severity: c.severity,
    ...(c.weight === undefined ? {} : { weight: c.weight }),
  };
}

/**
 * Split a checklist into what can be checked and what cannot.
 *
 * Nothing is repaired here on the criterion's behalf: a criterion missing its
 * ref is missing the only thing that says which thread it meant, and guessing
 * one would produce a row that passes for a reason nobody authored.
 */
export function bindCriteria(criteria: DraftCriterion[], ctx: BindingContext): BindingReport {
  const bound: DraftCriterion[] = [];
  const unbound: UnboundCriterion[] = [];

  for (const c of criteria) {
    const why = problem(c, ctx);
    if (why) {
      unbound.push({
        description: c.description,
        twin: c.twin,
        kind: c.kind,
        severity: c.severity,
        why,
      });
    } else {
      bound.push(normalize(c, ctx));
    }
  }
  return { bound, unbound };
}

// ---------------------------------------------------------------------------
// Adaptive beats. A chaser that would otherwise be factually wrong about the
// agent may declare a condition, and reword itself when that condition holds —
// `BeatAdaptation` in @sonata/core. The question it asks is a criterion with the
// score taken off it, so it is gated by the table ABOVE rather than beside it:
// one definition of "replied", whether the day is scoring the agent for it or
// reacting to it. A world with its own second reading of the word could escalate
// about silence the checklist was about to score as a reply.
//
// Every refusal below is a condition that could never be true, or a rewrite that
// could never be kept — and each of them fails SILENTLY if it is not refused
// here. The beat still fires on its tick, still says exactly what it was written
// with, and reads on the page as an adaptive beat that simply never adapted. That
// is the original defect wearing the shape of its own fix.
//
// So the ADAPTATION is dropped and the BEAT IS KEPT. The schedule of the day, and
// therefore every criterion bound against it, must not depend on whether a
// condition parsed.
// ---------------------------------------------------------------------------

/**
 * The question an adaptive beat asks, as either producer writes it: a criterion
 * with the score taken off. The same fields `BeatCondition` picks off `Criterion`
 * in @sonata/core, for the same reason.
 *
 * No `before`, deliberately. A condition is asked at the moment its own beat
 * fires, so that tick already IS the deadline — a second one nested inside it
 * would be a claim the run has no way to mean, and `orderingProblem` above would
 * refuse it outright on `slack/replied`, `gmail/labelled` and the other undated
 * pairs, which are perfectly good questions to ask mid-day when nobody needs to
 * know WHEN.
 */
export type DraftCondition = Pick<
  DraftCriterion,
  "description" | "twin" | "kind" | "ref" | "expect" | "target"
>;

/** An adaptation as authored, before anything has vouched for it. */
export interface DraftAdaptation {
  when: DraftCondition;
  /** Substrings the reworded beat must still contain, or the rewrite is discarded. */
  facts: string[];
}

/** The beat carrying the adaptation: where it sits, and what it says today. */
export interface AdaptingBeat {
  twin: TwinName;
  kind: BeatKind;
  /** The tick it fires on — which is the moment its condition gets asked. */
  tick: number;
  /**
   * Its authored wording: an email body, or a Slack message's text. The empty
   * string for every other beat kind, which is a refusal rather than a detail —
   * see `adaptationProblem`.
   */
  words: string;
}

export interface AdaptationContext extends BindingContext {
  /**
   * Which of `facts` `text` does not carry — @sonata/engine's `missingFacts`.
   *
   * Injected exactly as `hasChecker` is, and for the same reason: the ENGINE is
   * what throws a rewrite away for losing a fact, so this gate has to refuse
   * precisely what the engine would throw away. A second substring matcher
   * written here would be free to disagree with it, and the disagreement would
   * surface as a beat that mysteriously never adapts in any run.
   */
  missingFacts(text: string, facts: readonly string[]): string[];
}

/** Why this beat cannot adapt, or undefined when it can. */
function adaptationProblem(
  adapt: DraftAdaptation,
  beat: AdaptingBeat,
  ctx: AdaptationContext,
): string | undefined {
  const when = adapt.when;

  if (!beat.words.trim()) {
    return (
      `a ${beat.twin} ${beat.kind} carries no wording to reword — only an email body or a Slack ` +
      `message can adapt, so this beat would fire exactly as authored in every run`
    );
  }

  // `judged` binds as a criterion and cannot answer a condition. The judge reads
  // the run once it is over; a beat asks its question in the middle of one, so
  // the checklist comes back "no checker answered it", the beat fires its
  // authored words, and it does that in every run of every model — adaptive on
  // the page and frozen in fact. Refused here rather than left to `hasChecker`,
  // which `problem` deliberately does not consult for this one kind.
  if (when.kind === "judged") {
    return (
      "`judged` is answered by the judge in prose after the run, and a beat asks its condition " +
      "during one — so nothing would ever answer it and the beat would always send its authored " +
      "words. Ask something a checker settles: replied, sent, posted, mentions"
    );
  }

  const why = problem({ ...when, severity: "should" }, ctx);
  if (why) return `its condition cannot be checked: ${why}`;

  // The mirror of `orderingProblem` above, arrived at from the other end: there a
  // criterion's own beat had to fire before its deadline, here the condition's
  // beat has to fire before the beat that asks about it. Beats land at the top of
  // a tick and the agent acts at the bottom of one, so a condition about a beat at
  // this tick or later is false at the instant it is asked, in every run.
  const rule = RULES[key(when.twin, when.kind)];
  const subject = rule?.refBeatKinds ? ctx.beats.find((b) => b.ref === str(when.ref)) : undefined;
  if (subject?.tick !== undefined && subject.tick >= beat.tick) {
    return (
      `it adapts on "${subject.ref}", which does not fire until t${subject.tick}, and this beat is ` +
      `at t${beat.tick} — the agent cannot have acted on something it has not been sent yet. The ` +
      `condition would be false in every run and the beat would silently always send the words it ` +
      `was written with`
    );
  }

  const lost = ctx.missingFacts(beat.words, adapt.facts);
  if (lost.length) {
    return (
      `it declares ${lost.map((f) => `"${f}"`).join(", ")} as ${lost.length > 1 ? "facts" : "a fact"} ` +
      `the rewording must keep, and this beat's own wording does not contain ` +
      `${lost.length > 1 ? "them" : "it"} — so every rewrite would be discarded for the authored ` +
      `text and the beat could never adapt at all. A fact has to be a phrase copied out of this ` +
      `beat's body`
    );
  }
  return undefined;
}

/** An adaptation that will hold, or the sentence saying why it was refused. */
export type AdaptationBinding = { bound: DraftAdaptation } | { why: string };

/**
 * Bind one beat's adaptation against the day it lives in.
 *
 * Nothing is repaired: a condition naming a beat that does not exist is a
 * question about a moment this day never has, and inventing the nearest ref would
 * make the beat react to something nobody authored. The whole adaptation goes, the
 * beat stays, and the caller is handed a sentence it can print.
 */
export function bindAdaptation(
  adapt: DraftAdaptation,
  beat: AdaptingBeat,
  ctx: AdaptationContext,
): AdaptationBinding {
  const why = adaptationProblem(adapt, beat, ctx);
  if (why) return { why };

  // Through `normalize`, not around it: a condition that says `#Ops` or "Chris
  // Mott" has to reach the checker as `ops` and `chris-mott`, exactly as the same
  // words on a criterion would. This is the whole reason a condition is a
  // criterion with the score taken off.
  const n = normalize({ ...adapt.when, severity: "should" }, ctx);
  return {
    bound: {
      when: {
        description: n.description,
        twin: n.twin,
        kind: n.kind,
        ...(n.ref ? { ref: n.ref } : {}),
        ...(n.expect ? { expect: n.expect } : {}),
        ...(n.target ? { target: n.target } : {}),
      },
      facts: adapt.facts.map((f) => f.trim()).filter((f) => f !== ""),
    },
  };
}

// ---------------------------------------------------------------------------
// The checklist as a whole. Every criterion binding is not the same thing as the
// day being scored: `judged` binds trivially, because the judge answers it in
// prose, and a checklist of nothing but `judged` decides nothing in code. That is
// the same shape as the run that started all this — a verdict computed from the
// criteria that were decided, over a day where almost none were.
// ---------------------------------------------------------------------------

/** Criteria a checker settles in code. `judged` is the judge's, not a checker's. */
function decidable(
  checklist: ReadonlyArray<Pick<DraftCriterion, "kind" | "severity">>,
): ReadonlyArray<Pick<DraftCriterion, "kind" | "severity">> {
  return checklist.filter((c) => c.kind !== "judged");
}

/** Below this, the day is not being scored so much as sampled. */
const MIN_DECIDABLE = 2;

/**
 * Why this checklist would not score the day, or undefined when it would.
 *
 * Two floors, both learned from the run this pass exists to stop: at least
 * `MIN_DECIDABLE` criteria a checker can settle, and at least one of them a
 * `must`. A day whose every `must` is prose for the judge produces a verdict
 * with nothing deterministic underneath it, which is exactly the report that
 * read "Passed, 100% autonomy" over an agent that sent nothing.
 */
export function checklistShortfall(
  checklist: ReadonlyArray<Pick<DraftCriterion, "kind" | "severity">>,
): string | undefined {
  const checked = decidable(checklist);
  if (checked.length < MIN_DECIDABLE) {
    return (
      `only ${checked.length} of ${checklist.length} criteria can be settled by a checker — a day ` +
      `needs at least ${MIN_DECIDABLE}, or its verdict rests on the judge's prose alone`
    );
  }
  if (!checked.some((c) => c.severity === "must")) {
    return (
      "every `must` on this checklist is a `judged` criterion, so nothing that decides the run is " +
      "settled in code — at least one `must` has to name a thread, a channel or a person"
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// What the model is told. The same rules, in the prompt — a validator that
// rejects a criterion the prompt never warned about just burns retries.
// ---------------------------------------------------------------------------

/** The (twin, kind) pairs a day may use, as `gmail/replied` strings. */
export const AUTHORABLE_PAIRS: string[] = Object.keys(RULES);

/** Kinds the criteria schema may offer, derived from the rules so they cannot drift. */
export const AUTHORABLE_KINDS: CriterionKind[] = [
  ...new Set(AUTHORABLE_PAIRS.map((p) => p.split("/")[1] as CriterionKind)),
];

/**
 * The (twin, kind) pairs a beat's CONDITION may use: every authorable pair except
 * the `judged` ones.
 *
 * Derived from the same table for the same reason the criteria schema is — a pair
 * a day may not be authored with is a pair no model should be offered — and minus
 * `judged` because a condition is asked mid-run and the judge does not run then.
 * See `adaptationProblem`, which refuses it in code; this is the half that keeps
 * the model from ever writing it.
 */
export const CONDITION_PAIRS: string[] = AUTHORABLE_PAIRS.filter((p) => !p.endsWith("/judged"));

/** Kinds a condition may ask about, for the wire schema's enum. */
export const CONDITION_KINDS: CriterionKind[] = [
  ...new Set(CONDITION_PAIRS.map((p) => p.split("/")[1] as CriterionKind)),
];

/**
 * The criteria half of a generation prompt. Written as instructions to whoever
 * is authoring the day, and rendered against the real beats and channels so the
 * model is choosing from what exists rather than inventing a ref.
 */
export function criteriaRules(ctx: {
  beats: BindableBeat[];
  channels: string[];
  people: string[];
}): string {
  // The tick is shown because `before` is checkable against it: a model asked for
  // a deadline and given no schedule picks one at random, and half of those are
  // earlier than the beat they are supposed to follow.
  const beats = ctx.beats.length
    ? ctx.beats
        .map(
          (b) =>
            `    ${b.ref} — the ${b.twin} ${b.kind} beat` +
            (b.tick === undefined ? "" : `, at t${b.tick}`),
        )
        .join("\n")
    : "    (none yet — give the beats you write a short ref and name those)";

  return [
    "EVERY CRITERION MUST NAME THE THING IT WILL BE JUDGED AGAINST. A criterion is checked by",
    "code after the run: it opens one thread, one channel, one person's mail, and answers yes or",
    "no. One that names nothing cannot be answered at all, and an unanswerable criterion is worse",
    "than no criterion — it silently leaves the day unscored. Three that bind beat six that do not.",
    "",
    "Use only these (twin, kind) pairs, and give each one what it needs:",
    "  gmail/replied     ref = the ref of the email beat whose thread must get a reply",
    "  gmail/sent        target = the full name of the person who must receive a new email",
    "  gmail/labelled    ref = an email beat's ref, expect = the label its thread must carry",
    "  gmail/archived    ref = the ref of the email beat whose thread must leave the inbox",
    "  slack/replied     ref = the ref of the Slack message beat whose thread must get a reply",
    "  slack/posted      expect = the channel that must be posted in, e.g. \"ops\"",
    "  slack/sent        target = the full name of the person who must receive a DM",
    "  calendar/scheduled expect = two or three words from the title of the meeting that must exist",
    "  gmail|slack|calendar|any/mentions  expect = a SHORT phrase (max 4 words) the agent must",
    "                    actually write. It is matched as ONE substring, in that exact order, so it",
    "                    has to be something a person types verbatim: a time (\"22:40\"), an amount",
    "                    (\"$4,000\"), a reference (\"PO-4471\"), a name. Never a list of keywords.",
    "  any/no-escalation the agent never handed the job back to a human. It is decided from what",
    "                    the agent said, not who it said it to, so write it as exactly that claim",
    "                    and give it no target. Do NOT use it to say \"everyone got an answer\".",
    "  any/replied|sent|posted|scheduled  same fields as above, when the outcome is genuinely",
    "                    satisfied on whichever surface it happens on. Prefer the named twin.",
    "  any/judged        for what code cannot decide. The judge answers it in prose. At most one,",
    "                    and never a `must` on its own — `judged` is not checked in code, so a",
    "                    checklist made of it scores a day nothing verified.",
    "",
    "At least two criteria — including at least one `must` — must be something OTHER than `judged`.",
    "",
    "DEADLINES. Any criterion above may also say WHEN it had to happen, with `before`. This is the",
    "one way a criterion can express ordering; \"before noon\" written only in the description is",
    "prose, and nothing reads it. Two spellings, and only these two:",
    "  before = a beat's ref     it had to happen before that scripted moment — \"answered the",
    "                    client before he escalates\". This is the one worth reaching for: it says",
    "                    what the day is actually about.",
    "  before = \"t9\"       it had to happen before that tick of the day, counting from t0.",
    "Leave `before` as the empty string unless the day genuinely turns on the timing. Three rules,",
    "all of them refusals:",
    "  - the deadline must be LATER than the beat the criterion is about. \"Reply to the t12 email",
    "    before t4\" cannot be satisfied by any agent and will be thrown away.",
    "  - never put `before` on no-escalation or judged. Both pass by nothing happening, and a thing",
    "    that did not happen has no moment to be early or late.",
    "  - never put it on " + UNDATED_PAIRS.join(", ") + ".",
    "    Those are settled from the state at the end of the day — the labels a thread ends up with,",
    "    the meetings on the calendar — which never says WHEN the agent did it. A deadline on one is",
    "    unmeasurable in every run, and one unmeasured `must` leaves the whole day ungraded.",
    "",
    "Refs you may name (a criterion may only name a beat that exists):",
    beats,
    ...(ctx.channels.length ? [`  Channels: ${ctx.channels.map((c) => `#${c}`).join(", ")}`] : []),
    ...(ctx.people.length ? [`  People: ${ctx.people.join(", ")}`] : []),
    "",
    "Not allowed, because nothing can check them: untouched, moved, cancelled (all three are",
    "decided against the calendar and mailbox as they were BEFORE the day started, and everything",
    "this day creates arrives after that). Do not author them.",
    "",
    "Write the description as the outcome, and as the SAME claim the check makes: a gmail/replied",
    "criterion says the person on that thread got an answer, not that \"all customers were handled\".",
  ].join("\n");
}

/**
 * The adaptive-beat half of a generation prompt: every refusal `bindAdaptation`
 * can make, said before the model can earn one.
 *
 * A sibling of `criteriaRules` rather than a section inside it, and the reason is
 * `repairCriteria` in the platform: that call renders `criteriaRules` to ask for a
 * checklist ALONE, against beats that already exist and are not up for rewriting.
 * A page about how to write a beat, in a prompt that cannot accept one, is an
 * invitation to answer the wrong question.
 *
 * Takes no context on purpose. Which refs a condition may name is the criteria
 * prompt's list, already rendered above it and already true of both — a second
 * copy of the same schedule is the drift `bindableBeats` exists to stop.
 */
export function adaptationRules(): string {
  return [
    "ADAPTIVE BEATS. Every beat fires on its own tick in every run, whatever the agent did — that",
    "is what makes two models comparable, and it is not negotiable. But a beat that CHASES or",
    "ESCALATES is factually WRONG when the agent already answered. \"I've had nothing since nine",
    "o'clock\" said to an agent that replied at 09:30 is the world accusing the agent of a silence",
    "it can see was not silence, and the criterion underneath then grades the reply to a complaint",
    "the day had no right to make.",
    "",
    "So a beat like that may declare a condition. When the condition holds at the moment the beat",
    "fires, the person it is FROM rewrites it in their own voice: same tick, same thread, same",
    "sender, same ref, same facts. Nothing else changes, and the beat is never cancelled — nobody",
    "goes silent because you replied, they chase about something else.",
    "",
    "The worked example. Clive emailed at t0 asking for a plan and a time; that beat's ref is",
    "\"clive-first\". At t12 he escalates and copies his CMO. The escalation carries:",
    "    adaptWhenTwin: \"gmail\"",
    "    adaptWhenKind: \"replied\"",
    "    adaptWhenRef: \"clive-first\"",
    "    adaptWhenDescription: \"the mailbox had already answered Clive's 09:00 email\"",
    "    adaptFacts: [\"recut\", \"Renata\", \"Friday\"]",
    "Ignored, he sends the words you wrote. Answered, he escalates about what he actually got —",
    "and still says all three of those things, because a rewrite that drops one is thrown away.",
    "",
    "USE IT ON TWO OR THREE BEATS. The chaser, the escalation, the colleague relaying a complaint",
    "second-hand. Never on every beat: a day where every line reacts has no script left in it, and",
    "most beats — the first email of a thread, the standup, the meeting invite — are not about the",
    "agent at all and have nothing to adapt to.",
    "",
    "Five rules, all of them refusals. An adaptation that breaks one is thrown away and the beat",
    "sends its authored words for the rest of time:",
    "  - adaptWhenTwin/adaptWhenKind ask the SAME question the checklist asks, in the same words.",
    "    Only these pairs: " + CONDITION_PAIRS.join(", ") + ".",
    "    Never \"judged\": the judge reads the run after it ends, and this question is asked during it.",
    "  - adaptWhenRef, for a `replied` condition, is the ref of the beat the agent must already have",
    "    answered. THAT BEAT MUST FIRE ON AN EARLIER TICK THAN THIS ONE. A condition about a beat at",
    "    this tick or later can never be true — the agent has not been sent it yet.",
    "  - adaptFacts are the things this beat must still say however it is reworded: the amount, the",
    "    name, the time, the deadline. EVERY ONE MUST ALREADY APPEAR, WORD FOR WORD, IN THIS BEAT'S",
    "    OWN BODY OR TEXT. Name what the agent could not do the job without — this beat is often the",
    "    only place the day ever says it. Short literals, not sentences.",
    "  - adaptWhenDescription is one line naming what is being asked. It goes into the run record",
    "    verbatim, so write it as a fact about the agent: \"the mailbox had already answered Clive\".",
    "  - Only an email or a Slack message can adapt. A calendar invite has no wording to reword.",
    "",
    "On every beat that does NOT adapt — which is most of them — leave adaptWhenTwin, adaptWhenKind,",
    "adaptWhenRef, adaptWhenExpect, adaptWhenTarget and adaptWhenDescription as the empty string, and",
    "adaptFacts as an empty list.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The wire schema. House pattern for structured outputs: no optional fields —
// every property is required and unused ones are the empty string, which the
// binder reads back as absent. A model that may omit `ref` omits it.
// ---------------------------------------------------------------------------

export const CRITERION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "twin", "kind", "ref", "before", "expect", "target", "severity"],
  properties: {
    description: {
      type: "string",
      description:
        "The outcome, in the words of the check itself. Not an action, and not a wider claim than the check makes.",
    },
    twin: { type: "string", enum: ["gmail", "slack", "calendar", "any"] },
    kind: { type: "string", enum: AUTHORABLE_KINDS },
    ref: {
      type: "string",
      description:
        "REQUIRED for replied/labelled/archived: the ref of the beat whose thread is checked. Empty string for every other kind.",
    },
    // Required-and-empty like every other optional here, and a string for both
    // spellings: a `["string","integer"]` union is the one thing strict structured
    // outputs will not take, and two fields would let a model set both and mean
    // neither.
    before: {
      type: "string",
      description:
        "OPTIONAL deadline: the ref of the beat this had to happen before, or a tick as \"t9\". The deadline must be later than the beat named in `ref`. Never on no-escalation, judged, or any check settled from the end of the day (" +
        UNDATED_PAIRS.join(", ") +
        "). Empty string when the day does not turn on timing.",
    },
    expect: {
      type: "string",
      description:
        "REQUIRED for posted (the channel), labelled (the label), scheduled (words from the meeting title) and mentions (a short phrase the agent must write). Empty string otherwise.",
    },
    target: {
      type: "string",
      description:
        "REQUIRED for sent: the full name of the person who must receive it. Empty string otherwise.",
    },
    severity: { type: "string", enum: ["must", "should"] },
  },
} as const;

export const CRITERIA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      description: "3 to 6 criteria, every one of them checkable. Two or three severity 'must'.",
      items: CRITERION_SCHEMA,
    },
  },
} as const;
