import type { PersonRef, TwinName, WorldSeed } from "./world";

// An episode is a simulated workday: a world, a clock, a script of beats, a
// director that improvises around the script, and the criteria the day is
// scored against. It is pure data — an EpisodeSpec can be written to disk,
// diffed, and replayed on a different model with no code attached to it.

// ---------------------------------------------------------------------------
// Clock. Everything in an episode is dated from here; nothing in the engine may
// call `Date.now()` for simulated time, or two runs of the same spec stop being
// comparable. See `../clock` for the conversions.
// ---------------------------------------------------------------------------

export interface Clock {
  /**
   * Start of the simulated day, with an explicit UTC offset ("…Z" or "…+01:00").
   * The offset is required: a naive string would be read in the host machine's
   * zone and the same spec would produce a different day on a different laptop.
   */
  startISO: string;
  /** How many ticks the day runs for. Tick indices are 0 .. ticks-1. */
  ticks: number;
  /** Simulated minutes each tick advances — 15 for a normal workday. */
  simMinutesPerTick: number;
}

// ---------------------------------------------------------------------------
// Beat payloads. One payload shape per (twin, kind) pair, so a beat can never
// carry, say, a Slack channel on a calendar event.
// ---------------------------------------------------------------------------

export interface EmailPayload {
  from: PersonRef;
  to: PersonRef[];
  cc?: PersonRef[];
  subject: string;
  /** Plain text. Twins render their own HTML; specs stay diffable. */
  body: string;
  /**
   * Land this on the thread an earlier beat created, naming that beat's `ref`.
   * This is how a scripted follow-up ("any update?") attaches to real history
   * instead of arriving as an orphan.
   */
  inReplyTo?: string;
  labels?: string[];
  attachments?: Array<{ filename: string; mimeType: string; text: string }>;
}

export interface SlackMessagePayload {
  /** Channel name from `WorldSeed.channels`, or a `Person.id` for a DM. */
  channel: string;
  from: PersonRef;
  text: string;
  /** Reply into the thread an earlier beat started, naming that beat's `ref`. */
  threadRef?: string;
}

export interface SlackReactionPayload {
  /** The beat whose message is being reacted to. */
  messageRef: string;
  from: PersonRef;
  /** Emoji name without colons, e.g. "eyes". */
  emoji: string;
}

export interface CalendarInvitePayload {
  title: string;
  organizer: PersonRef;
  attendees: PersonRef[];
  startISO: string;
  endISO: string;
  location?: string;
  description?: string;
}

export interface CalendarMovePayload {
  /** The beat that created the event. */
  eventRef: string;
  startISO: string;
  endISO: string;
  reason?: string;
}

export interface CalendarCancelPayload {
  eventRef: string;
  reason?: string;
}

export type RsvpResponse = "accepted" | "declined" | "tentative";

export interface CalendarRsvpPayload {
  eventRef: string;
  who: PersonRef;
  response: RsvpResponse;
  comment?: string;
}

/** What a spec may write into a CRM attribute: the twin normalises all three. */
export type AttioWriteValue = string | number | Array<string | number>;

/** An account, a contact or a deal appears in the CRM mid-day. */
export interface AttioRecordPayload {
  /** "companies", "people" or "deals". */
  object: string;
  /** Keyed by attribute slug, e.g. `{name: "Northwind", domains: ["nw.example"]}`. */
  values: Record<string, AttioWriteValue>;
}

/**
 * How a beat says which CRM record it means.
 *
 * Three spellings, and the order they are tried in: the `ref` of an earlier beat
 * that created the record, the name the record carries in the CRM ("Harrowgate —
 * pricing engagement"), or its raw record id. The middle one is the one an author
 * can actually write, and it is why this type exists: the records the world was
 * seeded with have ids derived by a hash inside @sonata/world that appear in no
 * `WorldSeed`, no preview and nowhere on the dashboard, so a spec that could only
 * point at ids could only ever touch records its own beats had minted.
 */
export type AttioRecordTarget = string;

/** Somebody moves a deal on, renames an account, or hands one to a new owner. */
export interface AttioUpdatePayload {
  /** See `AttioRecordTarget`: a beat's `ref`, the record's name, or its id. */
  recordRef: AttioRecordTarget;
  object: string;
  /** A stage move is `{stage: "Won 🎉"}`; any attribute works the same way. */
  values: Record<string, AttioWriteValue>;
}

/** A conversation that happened elsewhere is logged against the record it was about. */
export interface AttioNotePayload {
  parentObject: string;
  /** See `AttioRecordTarget`: a beat's `ref`, the record's name, or its id. */
  parentRecordRef: AttioRecordTarget;
  title: string;
  content: string;
  format?: "plaintext" | "markdown";
}

/** A follow-up lands on somebody's list — the CRM's way of saying "this is owed". */
export interface AttioTaskPayload {
  content: string;
  deadlineISO?: string;
  /** Who it lands on. Must be someone in the cast, since the CRM seeds from it. */
  assignee?: PersonRef;
  /** Each `recordRef` is an `AttioRecordTarget` — a beat's ref, a name, or an id. */
  linkedRecords?: Array<{ object: string; recordRef: AttioRecordTarget }>;
}

/** One authored paragraph. `namedStyleType` is a Docs named style, e.g. "HEADING_1". */
export interface DocsParagraphPayload {
  text: string;
  namedStyleType?: string;
}

/** A colleague shares a brief the day is about. */
export interface DocsDocumentPayload {
  title: string;
  /** Cast member the document belongs to; the workspace owner when absent. */
  owner?: PersonRef;
  paragraphs: DocsParagraphPayload[];
}

/**
 * How a beat says which document it means: an earlier beat's `ref`, the
 * document's TITLE, or its 44-character id.
 *
 * The title is what an author writes, for the same reason a CRM record is named
 * rather than pointed at — a seeded document's id is a hash minted at seed time
 * and published nowhere — and it is also what the run timeline, the judge prompt
 * and the results page print, so a beat addressed by title reads as prose
 * everywhere instead of as 44 characters of base64.
 */
export type DocsDocumentTarget = string;

/** A colleague adds a section to a document that already exists. */
export interface DocsAppendPayload {
  documentRef: DocsDocumentTarget;
  paragraphs: DocsParagraphPayload[];
}

/** A placeholder is filled in, or a sentence is revised, wherever it appears. */
export interface DocsReplacePayload {
  documentRef: DocsDocumentTarget;
  find: string;
  replaceWith: string;
  matchCase?: boolean;
}

// ---------------------------------------------------------------------------
// Beat bodies. Split out from the beat's own metadata because the director
// emits the exact same (twin, kind, payload) triple at runtime — see
// `DirectorEvent` in ./run. One shape, two producers, one injector.
// ---------------------------------------------------------------------------

export type GmailBeatBody = { twin: "gmail"; kind: "email"; payload: EmailPayload };

export type SlackBeatBody =
  | { twin: "slack"; kind: "message"; payload: SlackMessagePayload }
  | { twin: "slack"; kind: "reaction"; payload: SlackReactionPayload };

export type CalendarBeatBody =
  | { twin: "calendar"; kind: "invite"; payload: CalendarInvitePayload }
  | { twin: "calendar"; kind: "move"; payload: CalendarMovePayload }
  | { twin: "calendar"; kind: "cancel"; payload: CalendarCancelPayload }
  | { twin: "calendar"; kind: "rsvp"; payload: CalendarRsvpPayload };

/**
 * One update kind rather than a `stage` kind and a `rename` kind: in this CRM
 * every attribute is written the same way — the current row is closed and a new
 * one opens — so splitting by attribute would be four names for one behaviour,
 * and the first attribute an episode wanted that nobody had named would be
 * unreachable.
 */
export type AttioBeatBody =
  | { twin: "attio"; kind: "record"; payload: AttioRecordPayload }
  | { twin: "attio"; kind: "update"; payload: AttioUpdatePayload }
  | { twin: "attio"; kind: "note"; payload: AttioNotePayload }
  | { twin: "attio"; kind: "task"; payload: AttioTaskPayload };

export type GoogleDocsBeatBody =
  | { twin: "google-docs"; kind: "document"; payload: DocsDocumentPayload }
  | { twin: "google-docs"; kind: "append"; payload: DocsAppendPayload }
  | { twin: "google-docs"; kind: "replace"; payload: DocsReplacePayload };

export type BeatBody =
  | GmailBeatBody
  | SlackBeatBody
  | CalendarBeatBody
  | AttioBeatBody
  | GoogleDocsBeatBody;

/** Every `kind` string in use, across all twins. */
export type BeatKind = BeatBody["kind"];

/**
 * What the agent may already have done by the time a beat fires — asked in the
 * SCORER's words, and never in a second vocabulary of the world's own.
 *
 * Every field here is picked off `Criterion` below, so the question goes to the
 * same fact providers in @sonata/judge that grade the run. That is the whole
 * design and not a convenience: if the world had its own idea of "replied", a day
 * could escalate about silence that the checklist was about to score as a reply,
 * and the report would contradict itself in one paragraph. One definition of
 * "replied", two readers of it.
 *
 * It is NOT a `Criterion`, and the two missing fields are why. `weight` and
 * `severity` are absent because this is a question and never a score: a condition
 * that could carry a weight is a condition somebody eventually pastes into a
 * checklist, and the world's reading of the agent must not move the number. See
 * "Don't let a character's opinion move the score" in the plan.
 */
export interface BeatCondition
  extends Pick<Criterion, "twin" | "kind" | "ref" | "target" | "expect" | "before"> {
  /** One line naming what is being asked. Goes on the tick record verbatim. */
  description: string;
}

/**
 * How a beat's WORDING adapts to what the agent actually did.
 *
 * Never WHETHER it fires. The beat happens on its own tick in every run, whatever
 * the agent did — that is the property that makes two models comparable, and it is
 * also just true of people: nobody goes silent because you replied, they chase
 * with different words. What adapts is the sentence, and only when `when` says in
 * code that the agent has already acted.
 *
 * `facts` is the safety catch. A beat is often the only place a number is ever
 * said — the £40k credit, the 15:00 machine — and every criterion downstream
 * depends on the agent having been told it. So the beat declares what it must
 * still get across whatever words it uses, and a rewrite that loses one is thrown
 * away in favour of the authored text. An empty list is a real statement — "no
 * fact here is load-bearing" — and it means a rewrite is accepted on its face.
 */
export interface BeatAdaptation {
  when: BeatCondition;
  /** Substrings the new wording must still contain, verbatim, or it is discarded. */
  facts: string[];
}

export interface BeatMeta {
  id: string;
  /** Which tick this fires on, 0-based. */
  tick: number;
  /**
   * Reword this beat when the agent has already done what `when` describes. The
   * tick, the sender, the surface, the thread and the beat's `ref` are untouched,
   * so every criterion binds exactly as it does without this field.
   *
   * Absent — which is every beat shipped today — is not a code path: the engine
   * checks for it before it does anything at all, so a beat without it fires the
   * bytes its author wrote and costs no model call and no extra read.
   */
  adapt?: BeatAdaptation;
  /**
   * Name this beat so later beats and criteria can point at what it created —
   * "the escalation email", "the 2pm review". The engine records the real
   * message/event id the twin returned under this name, so a criterion written
   * before the run can be checked against an artefact minted during it.
   */
  ref?: string;
  /** Author's note. Never shown to the agent; shown in the run timeline. */
  note?: string;
}

/**
 * One scripted thing that happens on the simulated day. Beats are fixed in
 * advance so runs stay comparable across models; everything reactive comes from
 * the director instead.
 */
export type Beat = BeatBody & BeatMeta;

// ---------------------------------------------------------------------------
// Director. The scripted beats are the same every run; the director is what
// makes the world *answer* the agent — the thing a static fixture cannot do.
// ---------------------------------------------------------------------------

export interface DirectorPersona {
  /** `Person.id` from the cast. Their `voice` is the base style. */
  personId: PersonRef;
  /** 0..1 — how likely they are to respond at all when addressed. */
  responsiveness: number;
  /** Ticks between being addressed and answering. 0 means same tick. */
  replyDelayTicks: number;
  /** Surfaces this persona will answer on; a client never appears in Slack. */
  surfaces: TwinName[];
  /** Extra standing instruction beyond `Person.voice`, e.g. "will not commit to a date". */
  brief?: string;
}

export interface DirectorPolicy {
  /**
   * Cap on improvised events per tick. Without it a chatty model turns one agent
   * email into a five-way thread and the day stops resembling a workday.
   */
  maxEventsPerTick: number;
  personas: DirectorPersona[];
  /**
   * Facts the world must never volunteer and moves it must never make — the
   * things that would hand the agent the answer. Rendered verbatim into the
   * director's prompt as prohibitions.
   */
  offLimits: string[];
  /** Prose guidance for everything the director writes: register, length, formality. */
  style: string;
}

// ---------------------------------------------------------------------------
// Success. Deterministic checklist first, judge questions for the residue —
// the same split that keeps the Gmail eval cheap and reproducible.
// ---------------------------------------------------------------------------

/**
 * The whole vocabulary of criterion kinds, and the only one.
 *
 * A VALUE, not merely a type, because every consumer needs the list at runtime:
 * the generator's JSON schema is built from it so a model cannot author outside
 * it, the judge's routing table is keyed by it so a kind cannot exist without a
 * decision about who answers it, and a spec read back off disk is checked
 * against it rather than trusted.
 *
 * It is a value because it was free text, and free text produced near-synonyms.
 * A model wrote `mentioned` where the checkers implement `mentions`; nothing
 * matched, nothing complained, and the criterion — a `must`, on a report someone
 * was reading — came back "no deterministic checker exists for slack/mentioned"
 * and quietly became judge prose. One word out of place cost a run its only
 * deterministic answer to the question it was really about.
 *
 *   replied        a reply landed on the thread/message named by `ref`
 *   sent           a new email, DM or invitation reached `target`
 *   posted         something was posted in the channel named by `expect`
 *   labelled       the item named by `ref` carries the label in `expect`
 *   archived       the item named by `ref` left the inbox/queue
 *   scheduled      an event matching `expect` exists that did not before
 *   moved          the event named by `ref` changed time
 *   cancelled      the event named by `ref` is cancelled
 *   untouched      the item named by `ref` was deliberately left alone
 *   mentions       something the agent wrote contains `expect`, or names `target`
 *   no-escalation  the agent never handed the job back to a human
 *   judged         nothing deterministic can settle it — the judge answers it
 *
 * `judged` is the one deliberate hole, and it is deliberate: a kind with no
 * checker has to say so in the vocabulary, where a reader sees it, rather than
 * by being missing from a table, where nobody does.
 */
export const CRITERION_KINDS = [
  "replied",
  "sent",
  "posted",
  "labelled",
  "archived",
  "scheduled",
  "moved",
  "cancelled",
  "untouched",
  "mentions",
  "no-escalation",
  "judged",
] as const;

export type CriterionKind = (typeof CRITERION_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(CRITERION_KINDS);

/**
 * Near-synonyms that saved artifacts already carry, and the kind each one meant.
 *
 * Evidence-driven, and exactly as long as the evidence. A census of every
 * criterion in every spec under `apps/platform/data/runs` and in the `episodes`
 * table turned up one word outside the vocabulary — `mentioned`, in three saved
 * specs, once as a `must`. Aliasing it is what makes those artifacts re-derive
 * as CHECKED rather than stay permanently undecided; without it, closing the
 * vocabulary would only convert a silent hole into a loud one.
 *
 * Nothing speculative belongs here. A kind nobody has ever written is a guess,
 * and a guess in this map silently accepts a word the generator should have been
 * refused for — which is the defect, not the fix.
 */
export const CRITERION_KIND_ALIASES: Readonly<Record<string, CriterionKind>> = {
  mentioned: "mentions",
};

export function isCriterionKind(value: string): value is CriterionKind {
  return KIND_SET.has(value);
}

/**
 * The canonical kind for whatever an artifact or a model actually wrote, or null.
 *
 * Null is the point of the signature: it is the difference between a word that
 * can be routed and a word that cannot, and it forces every caller to say out
 * loud what it does with the second case — reject it at authoring time, or
 * report it as this harness's defect at check time. What no caller can do any
 * more is treat it as an ordinary kind that merely happens to have no checker.
 */
export function asCriterionKind(value: string): CriterionKind | null {
  const key = value.trim().toLowerCase();
  if (isCriterionKind(key)) return key;
  return CRITERION_KIND_ALIASES[key] ?? null;
}

export interface Criterion {
  id: string;
  /**
   * Written as the outcome, not the action: "the client got an answer before noon".
   * The "before noon" half is `before` below — prose here is never read by a check,
   * so until that field existed the example in this very comment was a claim only
   * half of which the system could settle.
   */
  description: string;
  /** `any` for criteria that span surfaces, e.g. cross-surface consistency. */
  twin: TwinName | "any";
  kind: CriterionKind;
  /**
   * Ordering: the thing this criterion checks must ALSO have happened before a
   * moment in the day. Two spellings, one field:
   *
   *   "escalation"  a beat's `ref` — before that scripted moment fired
   *   "t12"         an absolute tick — "before noon", on a day that starts at 09:00
   *
   * ONE field rather than a `beforeRef`/`beforeTick` pair, because a deadline is
   * one thing and two fields can contradict each other: an author who sets both
   * has written a criterion whose meaning depends on which one some checker
   * happens to read first. A single string cannot disagree with itself. It is
   * also the only shape the generator's wire schema wants — every property
   * required, the empty string when unused (see `CRITERION_SCHEMA`).
   *
   * Read as a beat ref first, and as `t<n>` only when no beat answers to that
   * name. A `before` that is BOTH — a beat whose ref is literally "t12" — is
   * refused at authoring, because a checker only knows the beats that FIRED and
   * would otherwise read the same word two different ways in two runs of one spec.
   *
   * A REFINEMENT and never a replacement: a criterion whose underlying check
   * failed keeps failing for that reason, with that evidence. Ordering can only
   * turn a pass into a late failure, or into "we cannot tell when" — see
   * `runChecklist` in @sonata/judge.
   *
   * Only on a check that records WHEN: a reply, a send, a phrase the agent wrote.
   * A check settled from the state at the END of the day — the labels a thread
   * ends up with, whether it is out of the inbox, a meeting on the calendar —
   * records no tick, so a deadline on one comes back unmeasured in every run, and
   * an unmeasured `must` leaves the whole day ungraded. `bindCriteria` refuses
   * those pairs by name; a hand-written spec has no such gate and must not write
   * one.
   */
  before?: string;
  /**
   * The beat this is about, by `BeatMeta.ref`. Optional because some criteria are
   * about something the agent should have originated ("told the team"), which no
   * beat created — checkers must handle its absence rather than assume a target.
   */
  ref?: string;
  /** Second argument for the check: a label name, a channel, a person, a phrase. */
  expect?: string;
  /** Who the action should have reached, for `sent` / `posted`. */
  target?: PersonRef;
  /** Relative weight in the score. 1 unless the criterion carries the episode. */
  weight: number;
  /** A failed `must` fails the run outright; a failed `should` only costs score. */
  severity: "must" | "should";
}

export interface SuccessCriteria {
  checklist: Criterion[];
  /**
   * Qualitative questions the checklist cannot reach — judgement, tone, whether
   * the agent actually understood the day. Asked once, after the run.
   */
  judgeQuestions: string[];
}

// ---------------------------------------------------------------------------
// Termination. A runaway agent loop is billable, so every stop condition is
// declared on the spec rather than hard-coded in the engine.
// ---------------------------------------------------------------------------

export interface Termination {
  /** Stop early once every `must` criterion passes, instead of burning the day. */
  stopWhenAllMustPass: boolean;
  /** Hard tick cap. Absent means `clock.ticks`; present, the lower of the two wins. */
  maxTicks?: number;
  /** Consecutive ticks with no agent tool call that end the run. */
  idleTicks: number;
  /** Wall-clock guard, independent of simulated time. */
  maxWallClockMs: number;
  /** Spend guard in USD across every model call in the run, agent and director. */
  maxCostUsd?: number;
}

export interface EpisodeSpec {
  id: string;
  title: string;
  /** The day as a story, in prose. Shown in the dashboard; given to the judge. */
  story: string;
  /**
   * The agent's standing brief — its entire job description, handed over once at
   * tick 0. Everything the agent knows after that it has to find for itself.
   */
  task: string;
  world: WorldSeed;
  clock: Clock;
  beats: Beat[];
  director: DirectorPolicy;
  success: SuccessCriteria;
  termination: Termination;
}
