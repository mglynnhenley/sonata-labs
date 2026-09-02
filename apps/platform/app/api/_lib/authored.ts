import {
  asCriterionKind,
  CRITERION_KINDS,
  tickLabel,
  tickToISO,
  TWIN_NAMES,
  type Beat,
  type BeatBody,
  type Clock,
  type Criterion,
  type DirectorPersona,
  type EpisodeSpec,
  type Person,
  type Termination,
  type TwinName,
  type WorldSeed,
} from "@sonata/core";
import { beatWords, missingFacts } from "@sonata/engine";
import { factNameFor } from "@sonata/judge";
import {
  bindAdaptation,
  bindCriteria,
  type BindableBeat,
  type BindingContext,
  type DraftAdaptation,
  type DraftCriterion,
  type UnboundCriterion,
} from "@sonata/world";
import type { BeatPreview, ScenarioDraft, WorldCounts } from "./types";
import { newId } from "./store";

// The middle language between "someone described a business" and an EpisodeSpec.
//
// Both producers — the model in draft.ts and the hand-written templates — emit
// this same loose shape, and this file is the only thing that turns it into the
// strict @sonata/core types. That split is deliberate: prose is the model's job,
// identity and time are code's. The model never invents an email address, a
// Slack id or an ISO timestamp, because those are the joins that make the clone
// coherent and a hallucinated one silently breaks the world.

export interface AuthoredPerson {
  name: string;
  role: string;
  /**
   * How they stand to the mailbox owner. One of `RELATIONSHIPS`, which is a
   * closed vocabulary because `surfacesFor` decides containment by reading it.
   */
  relationship: string;
  /** Style notes: sentence length, greeting, quirks, mood. HOW THEY TYPE. */
  voice: string;
  /**
   * HOW THEY BEHAVE: what they want, what they will accept, what they will never
   * do. Becomes `DirectorPersona.brief`, which the director renders as that
   * person's standing instruction.
   *
   * Optional, and every field below it is, because both producers must survive
   * without one: the shipped templates predate these fields, and a model that
   * omits them still has to yield a runnable day. `personaFor` falls back rather
   * than dropping the person.
   */
  brief?: string;
  /** 0..1 — how likely they are to answer when addressed. Clamped in `personaFor`. */
  responsiveness?: number;
  /** Ticks between being addressed and answering. Clamped in `personaFor`. */
  replyDelayTicks?: number;
}

export interface AuthoredChannel {
  name: string;
  purpose: string;
  /** Cast names. Anything unrecognised is dropped rather than invented. */
  members: string[];
  isPrivate?: boolean;
}

/** The four beat kinds a generated day is allowed to use. */
export type AuthoredBeatKind = "email" | "message" | "invite" | "move";

export interface AuthoredBeat {
  tick: number;
  twin: TwinName;
  kind: AuthoredBeatKind;
  /** Name this beat so later beats and criteria can point at what it created. */
  ref?: string;
  /** Author's note, shown in the run timeline and never to the agent. */
  note?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  inReplyTo?: string;
  channel?: string;
  text?: string;
  threadRef?: string;
  title?: string;
  attendees?: string[];
  durationMinutes?: number;
  eventRef?: string;
  reason?: string;
  /**
   * How this beat rewords itself when the agent has already acted — the fields
   * of a `BeatCondition` and the facts the rewording must keep, FLAT.
   *
   * All of `BeatCondition` except `before`, which a condition asked in the middle
   * of the day cannot mean: the beat's own tick already IS the deadline. A
   * hand-written day may still set it; see `DraftCondition` in @sonata/world.
   *
   * Flat and not nested because the wire schema is flat and "" means absent: a
   * nested object with every field optional is the shape a model answers by
   * leaving out, which is exactly how a checklist of criteria that named nothing
   * got authored. `authoredAdaptation` folds these back into one thing, and
   * @sonata/world's `bindAdaptation` decides whether it survives.
   */
  adaptWhenTwin?: string;
  adaptWhenKind?: string;
  adaptWhenRef?: string;
  adaptWhenExpect?: string;
  adaptWhenTarget?: string;
  adaptWhenDescription?: string;
  adaptFacts?: string[];
}

/**
 * A criterion as either producer writes it. The shape — and the rules that make
 * one checkable — live in @sonata/world, because the model that authors a day
 * and the templates that ship with the product must be held to the same bar: a
 * criterion that names no thread, channel or person is unanswerable, and an
 * unanswerable `must` is what let a run where nothing was sent score 100%.
 */
export type AuthoredCriterion = DraftCriterion;

/**
 * A criterion as it comes off the wire, before anything has vouched for `kind`.
 *
 * `DraftCriterion.kind` is typed `CriterionKind`, and the value is whatever a
 * model put in a JSON field. The two are the same thing only because something
 * checks, and until this file that something did not exist: the model wrote
 * `mentioned`, TypeScript believed it, the criterion was stored, and the judge
 * found no checker for it months later on a report someone was already reading.
 */
type RawCriterion = Omit<AuthoredCriterion, "kind"> & { kind: string };

/**
 * Why a criterion will not be checked — @sonata/world's `UnboundCriterion` with
 * `kind` left as the author WROTE it.
 *
 * An unknown kind is precisely the thing that cannot be typed as a
 * `CriterionKind`, and losing the word loses the diagnosis: "no criterion of kind
 * `mentioned`" is a sentence someone can act on, and a rejected criterion filed
 * under a kind we substituted for it is not.
 */
export interface RejectedCriterion extends Omit<UnboundCriterion, "kind"> {
  kind: string;
}

/**
 * Resolve every criterion's `kind` against the one vocabulary, before anything
 * else in this file looks at one.
 *
 * Two outcomes and no third. A near-synonym the census found in real artifacts —
 * `mentioned` for `mentions` — is resolved, because refusing a word we know the
 * meaning of would spend a regeneration to fix a spelling. Anything else is
 * REJECTED, which is what puts it in front of `repairCriteria` and keeps it out
 * of storage: a criterion whose kind nothing can route is unanswerable, and an
 * unanswerable `must` is how a day scores 100% for work nobody verified.
 */
export function vetCriterionKinds(criteria: AuthoredCriterion[]): {
  ok: AuthoredCriterion[];
  rejected: RejectedCriterion[];
} {
  const ok: AuthoredCriterion[] = [];
  const rejected: RejectedCriterion[] = [];

  for (const raw of criteria as RawCriterion[]) {
    const kind = asCriterionKind(String(raw.kind ?? ""));
    if (kind) {
      ok.push({ ...raw, kind });
      continue;
    }
    rejected.push({
      description: raw.description,
      twin: raw.twin,
      kind: String(raw.kind ?? ""),
      severity: raw.severity,
      why:
        `"${raw.kind}" is not a criterion kind. The whole vocabulary is ` +
        `${CRITERION_KINDS.join(", ")} — pick the one whose check actually answers this claim`,
    });
  }
  return { ok, rejected };
}

export interface AuthoredEpisode {
  title: string;
  story: string;
  task: string;
  beats: AuthoredBeat[];
  criteria: AuthoredCriterion[];
}

export interface AuthoredScenario {
  business: { name: string; industry: string; size: number; description: string };
  /** Cast name of the person whose accounts the agent operates. */
  owner: string;
  cast: AuthoredPerson[];
  channels: AuthoredChannel[];
  /**
   * Facts nobody in this company may volunteer and moves nobody may make — the
   * things that would hand the agent the answer. ADDED to `ALWAYS_OFF_LIMITS`,
   * never in place of it; see that constant for why.
   */
  offLimits?: string[];
  /** The register everyone writes in. Falls back to `DEFAULT_STYLE` when absent. */
  style?: string;
  episode: AuthoredEpisode;
}

// ---------------------------------------------------------------------------
// Identity. Derived, never authored — see the file header.
// ---------------------------------------------------------------------------

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function emailDomain(businessName: string): string {
  const base = slug(businessName).replace(/-/g, "");
  return `${base || "acme"}.com`;
}

function toPerson(authored: AuthoredPerson, domain: string): Person {
  const id = slug(authored.name) || newId("person");
  const parts = authored.name.trim().split(/\s+/);
  const local = parts.length > 1 ? `${slug(parts[0]!)}.${slug(parts[parts.length - 1]!)}` : id;
  return {
    id,
    name: authored.name,
    email: `${local}@${domain}`,
    slackUserId: `U${id.replace(/-/g, "").toUpperCase().slice(0, 10)}`,
    role: authored.role,
    // Folded to the vocabulary here and nowhere else, so `Person.relationship`
    // is the one reading of the word: the persona's surfaces, the seeder's
    // prompt and the preview all take it from this field, and a "Client" that
    // stayed capitalised would have to be re-normalised by every one of them —
    // which is the shape the containment bug had in the first place.
    relationship: authoredText(authored.relationship)?.toLowerCase() ?? "",
    voice: authored.voice,
  };
}

// ---------------------------------------------------------------------------
// The clock. A generated day always starts at 09:00 on the next weekday, in the
// host's own UTC offset — so the times a user reads in the preview are the times
// they would read on their own calendar, and the offset is explicit, which
// @sonata/core's clock requires.
// ---------------------------------------------------------------------------

function offsetSuffix(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function nextWorkdayClock(ticks: number, simMinutesPerTick = 15): Clock {
  const day = new Date();
  day.setHours(9, 0, 0, 0);
  if (Date.now() > day.getTime()) day.setDate(day.getDate() + 1);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);

  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  return { startISO: `${date}T09:00:00${offsetSuffix(day)}`, ticks, simMinutesPerTick };
}

// ---------------------------------------------------------------------------
// Guards, sized to the day the scenario declares.
//
// These were flat — 20 minutes and $2 for every generated day, whether it
// declared 8 ticks or 32. A real tick is a model turn of up to a dozen steps and
// takes tens of seconds, so a 32-tick day could not finish inside 20 minutes by
// ANY model: the guard fired around tick 12, the run was filed `done`, and the
// beats scheduled after it never happened. It was then graded against the whole
// 32-tick checklist, and the agent wore a critical for ignoring a customer whose
// message the harness had stopped the clock before sending. A budget that the
// declared day cannot fit inside is not a runaway guard, it is a truncation with
// a scoring bug behind it.
//
// So they scale. They are still guards and still bite a genuine runaway — they
// are simply no longer guaranteed to bite a day that is merely long.
// ---------------------------------------------------------------------------

/** Generous per tick, because the guard's job is to catch a loop, not to pace a day. */
const WALL_CLOCK_MS_PER_TICK = 45_000;
const USD_PER_TICK = 0.12;

/** Floors, so a short day keeps the headroom it always had. */
const MIN_WALL_CLOCK_MS = 20 * 60_000;
const MIN_COST_USD = 2;

function guardsFor(clock: Clock): Termination {
  return {
    stopWhenAllMustPass: false,
    // Consecutive dead intervals, not a fraction of the day: six in a row is a
    // stalled agent at any length, and scaling this one would let a long day
    // stall for an hour before anyone noticed.
    idleTicks: 6,
    maxWallClockMs: Math.max(MIN_WALL_CLOCK_MS, clock.ticks * WALL_CLOCK_MS_PER_TICK),
    maxCostUsd: Math.max(MIN_COST_USD, Number((clock.ticks * USD_PER_TICK).toFixed(2))),
  };
}

// ---------------------------------------------------------------------------
// The director's cast — who these people are, and what the engine may be told.
//
// The split is the same one the file header sets out. Prose is the author's:
// a brief — what someone wants, what they will accept, what they will never do —
// is the only thing that makes two generated people different people, and it
// cannot be derived from a relationship. Every generated persona used to BE
// three if-statements on `relationship` with no brief at all, which is why six
// people out of the same company read as one person in six fonts.
//
// Structure stays code's, and there are two halves to that here:
//
//   - NUMBERS ARE VALIDATED. `responsiveness` and `replyDelayTicks` are printed
//     into the director's prompt and used to schedule replies, so an authored
//     1.4 or -3 would reach the engine exactly as the model wrote it. Authored
//     values are clamped into the range the field means; anything unusable falls
//     back to the derivation rather than costing the day a character.
//   - `surfaces` IS NOT AUTHORABLE AT ALL. It is the one persona field that is a
//     containment rule rather than a characterisation: a client lives outside
//     the company and must never appear in Slack. The moment a model can write
//     that field, a model can put one there — and who-knows-what stops being
//     structural and goes back to being a bullet point we hope it reads.
//
//     Which is why `relationship` is a closed vocabulary and not free text: the
//     rule is only as structural as the word it reads. Unauthorable `surfaces`
//     plus an authorable "Client" is the same leak by a longer route, and that
//     was the actual state of it — see `RELATIONSHIPS`.
// ---------------------------------------------------------------------------

/**
 * How a cast member may stand to the mailbox owner, and the whole vocabulary.
 *
 * Closed and exported because draft.ts builds the model's enum from this list.
 * `surfaces` is only a containment rule for as long as the word it reads is one
 * this file has decided about: it used to be a free-text field with the six
 * values in a `description`, so `"Client"` — one capital, the shape a model
 * writes when it is echoing a role — matched neither arm of the ternary, and the
 * outsider it named was handed Slack. `twin` and `kind` are pinned this way in
 * the same schema for the same reason.
 */
export const RELATIONSHIPS = [
  "self",
  "manager",
  "peer",
  "report",
  "client",
  "vendor",
  "candidate",
] as const;

/**
 * The ones who are not in the company, and so answer on email and nowhere else.
 *
 * `candidate` belongs here and was missing: an interviewee with a competing
 * offer is as outside the company as a client, and the shipped
 * candidate-scheduling day put her in #hiring — where the debrief, the other
 * candidate and the loop's own scheduling live. The hand-written
 * packages/scenarios version of that day has always had the candidate on
 * ["gmail"], and this is the derivation being held to it.
 *
 * A word outside `RELATIONSHIPS` is treated as internal, which is the deliberate
 * side to fail on: an unrecognised word that meant "colleague" would otherwise
 * empty the whole company out of Slack and the day's cross-surface difficulty
 * with it, which is silent and total, where the other way round is one person
 * and visible in the transcript. The enum is what keeps that case rare.
 */
const EXTERNAL_RELATIONSHIPS: ReadonlySet<string> = new Set(["client", "vendor", "candidate"]);

/** Where someone answers, from where they stand to the company. Never authored. */
function surfacesFor(relationship: string): TwinName[] {
  return EXTERNAL_RELATIONSHIPS.has(relationship)
    ? (["gmail"] as TwinName[])
    : (["gmail", "slack"] as TwinName[]);
}

/**
 * An authored number, or undefined when the model did not actually give one.
 *
 * `Number("")` is 0, and "" is this file's marker for a field left blank — so the
 * naive read turns "the model said nothing" into "responsiveness 0", a cast
 * member who never speaks and cannot be told apart from one the model forgot.
 * A numeral arriving as a string is accepted, because that is the other thing
 * models do to a `number` field.
 */
function authoredNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * An authored string, or undefined when the model did not actually write one.
 *
 * The sibling of `authoredNumber`, and it exists for the harder half of the same
 * reason. The schema is sent with `strict: false` and llm.ts falls back to
 * asking for the JSON in prose when a provider cannot do structured outputs —
 * "the assembler validates instead" is that file's own note — so a field typed
 * `string` arrives as whatever the model felt like: a number, a list, an object.
 * `.trim()` on one of those threw a TypeError out of the whole assembly, and
 * `draftScenario` caught it and handed the user a template with "line.trim is
 * not a function" where the reason should be. One mistyped off-limits line cost
 * a whole good day — the cast, the beats and the criteria were all fine.
 */
function authoredText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * An entry that says nothing: a trailing comma in a list, a blanked-out slot.
 *
 * Distinguished from an entry this code merely could not READ, because the two
 * deserve opposite treatment — see `authoredAdaptation`. @sonata/engine's
 * `missingFacts` skips a blank fact when it checks a rewrite, so refusing over one
 * would cost a good adaptation for a stray comma.
 */
function blankEntry(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** One unreadable entry, short enough to print in a sentence. */
function showEntry(value: unknown): string {
  const shown = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return `"${shown.length > 60 ? `${shown.slice(0, 57)}…` : shown}"`;
}

/**
 * The longest an authored delay may be. Four ticks is an hour of simulated time;
 * beyond that a persona in a short day never gets to answer at all, which reads
 * on the transcript as a character the world forgot to write.
 */
const MAX_REPLY_DELAY_TICKS = 4;

/** Two of the old three if-statements, kept exactly — they are now the fallback, not the rule. */
function derivedResponsiveness(relationship: string): number {
  return relationship === "client" ? 0.7 : 0.85;
}
function derivedReplyDelay(relationship: string): number {
  return relationship === "client" ? 2 : 1;
}

/**
 * One cast member's persona: authored where the author spoke, derived where they
 * did not.
 *
 * Takes the assembled `Person` rather than a bare id so the three derivations
 * below read the same normalised `relationship` the rest of the world does —
 * `toPerson` folds it once, and nothing here gets to fold it differently.
 */
function personaFor(authored: AuthoredPerson, person: Person): DirectorPersona {
  const responsiveness = authoredNumber(authored.responsiveness);
  const delay = authoredNumber(authored.replyDelayTicks);
  const brief = authoredText(authored.brief);
  const relationship = person.relationship;
  return {
    personId: person.id,
    responsiveness:
      responsiveness === undefined
        ? derivedResponsiveness(relationship)
        : Math.min(1, Math.max(0, responsiveness)),
    replyDelayTicks:
      delay === undefined
        ? derivedReplyDelay(relationship)
        : Math.min(MAX_REPLY_DELAY_TICKS, Math.max(0, Math.round(delay))),
    surfaces: surfacesFor(relationship),
    // Omitted rather than blank: the director prints the standing-instruction
    // line only when there is one, and an empty one reads to a model as an
    // instruction it failed to receive.
    ...(brief ? { brief } : {}),
  };
}

/**
 * Prohibitions that hold for every generated day, whatever else was authored.
 *
 * Not generic filler to be replaced — they are the two rules that keep the
 * benchmark measuring the agent instead of the world's helpfulness. A model
 * asked to write off-limits for a logistics firm writes about the logistics
 * firm; it does not think to restate "do not do the agent's job for it", and a
 * world that coaches is a world that scores itself. Authored lines are added to
 * these, and the specific ones are where the day's real secrets live.
 */
const ALWAYS_OFF_LIMITS: readonly string[] = [
  "Never tell the agent what to do next, or name the action it should take.",
  "Never volunteer a fact it has not asked for.",
];

/** The register when nobody authored one. */
const DEFAULT_STYLE = "Short, busy, specific. Write like someone with six other things open.";

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function resolveRef(name: string | undefined, byName: Map<string, Person>): string | undefined {
  if (!name) return undefined;
  const person = byName.get(name.trim().toLowerCase());
  // Not in the cast: keep the raw string. A stranger emailing in is a real beat,
  // and inventing a cast member for them would corrupt the shared cast.
  return person ? person.id : name.trim();
}

function buildBody(
  beat: AuthoredBeat,
  byName: Map<string, Person>,
  channels: Set<string>,
  clock: Clock,
  ownerId: string,
): BeatBody | null {
  const from = resolveRef(beat.from, byName) ?? ownerId;

  if (beat.twin === "gmail" && beat.kind === "email") {
    const to = (beat.to ?? []).map((t) => resolveRef(t, byName)).filter((t): t is string => !!t);
    if (!beat.subject || !beat.body) return null;
    return {
      twin: "gmail",
      kind: "email",
      payload: {
        from,
        to: to.length > 0 ? to : [ownerId],
        ...(beat.cc?.length
          ? { cc: beat.cc.map((c) => resolveRef(c, byName)).filter((c): c is string => !!c) }
          : {}),
        subject: beat.subject,
        body: beat.body,
        ...(beat.inReplyTo ? { inReplyTo: beat.inReplyTo } : {}),
      },
    };
  }

  if (beat.twin === "slack" && beat.kind === "message") {
    const channel = beat.channel?.replace(/^#/, "").trim();
    if (!beat.text || !channel || !channels.has(channel)) return null;
    return {
      twin: "slack",
      kind: "message",
      payload: {
        channel,
        from,
        text: beat.text,
        ...(beat.threadRef ? { threadRef: beat.threadRef } : {}),
      },
    };
  }

  if (beat.twin === "calendar" && beat.kind === "invite") {
    if (!beat.title) return null;
    const minutes = Math.max(15, Math.min(beat.durationMinutes ?? 30, 240));
    const startISO = tickToISO(clock, beat.tick);
    return {
      twin: "calendar",
      kind: "invite",
      payload: {
        title: beat.title,
        organizer: from,
        attendees: (beat.attendees ?? [])
          .map((a) => resolveRef(a, byName))
          .filter((a): a is string => !!a),
        startISO,
        endISO: new Date(Date.parse(startISO) + minutes * 60_000).toISOString(),
      },
    };
  }

  if (beat.twin === "calendar" && beat.kind === "move") {
    if (!beat.eventRef) return null;
    const minutes = Math.max(15, Math.min(beat.durationMinutes ?? 30, 240));
    const startISO = tickToISO(clock, beat.tick + 2);
    return {
      twin: "calendar",
      kind: "move",
      payload: {
        eventRef: beat.eventRef,
        startISO,
        endISO: new Date(Date.parse(startISO) + minutes * 60_000).toISOString(),
        ...(beat.reason ? { reason: beat.reason } : {}),
      },
    };
  }

  return null;
}

/**
 * The adaptation the model wrote on this beat, or undefined when it wrote none.
 *
 * Three answers, not two. "" everywhere means the model left the fields alone and
 * this beat is not adaptive, which is most of them; a validated adaptation goes to
 * `bindAdaptation`; and a HALF-filled one — a ref and a description with no kind,
 * or a kind nothing can route — is neither. Returning undefined for that third
 * case would drop what the model was plainly trying to write without a word
 * anywhere, which is the silence this whole gate exists to break.
 *
 * `asCriterionKind` decides what the kind word means, exactly as it does for a
 * criterion: one vocabulary, one resolver, so `mentioned` means `mentions` in a
 * condition too rather than being refused in one place and accepted in the other.
 */
function authoredAdaptation(beat: AuthoredBeat): DraftAdaptation | { why: string } | undefined {
  const kind = authoredText(beat.adaptWhenKind);
  const twin = authoredText(beat.adaptWhenTwin);
  const ref = authoredText(beat.adaptWhenRef);
  const expect = authoredText(beat.adaptWhenExpect);
  const target = authoredText(beat.adaptWhenTarget);
  const description = authoredText(beat.adaptWhenDescription);
  // `authoredText` on each entry, not a cast: a `string[]` field comes back
  // holding numbers and objects often enough that one of them would otherwise
  // reach @sonata/engine's substring match and throw out of the whole assembly.
  const listed: unknown[] = Array.isArray(beat.adaptFacts) ? beat.adaptFacts : [];
  const facts = listed.map(authoredText).filter((f): f is string => f !== undefined);

  // But the survivors alone are NOT the answer, and reading them as one is the
  // safety catch quietly coming off. `facts` is the whole of what stops a rewrite
  // dropping the £40k credit that this beat is the only place the day ever says:
  // the engine discards a rewrite that lost one, and an EMPTY list is a real
  // statement — "nothing here is load-bearing" — so a rewrite is then accepted on
  // its face. Silently skipping the entries this code could not read turns a
  // declared fact into that statement, with nothing anywhere saying so. The beat
  // adapts, the number vanishes, `shownText` still swears the agent was told it,
  // and a criterion downstream fails the agent for a figure it was never sent.
  //
  // So they are counted and REPORTED, exactly like the half-filled condition
  // below, and the adaptation goes rather than binding weakened. A whole field
  // that is not a list counts as one unreadable entry: "recut, Renata, £40,000"
  // arriving as a single comma-joined string is the ordinary way a `string[]`
  // comes back wrong — the same accident `authoredText` was written for — and
  // splitting it here would be code guessing at prose.
  const unreadable: unknown[] = [
    ...listed.filter((f) => !blankEntry(f) && authoredText(f) === undefined),
    ...(Array.isArray(beat.adaptFacts) || blankEntry(beat.adaptFacts) ? [] : [beat.adaptFacts]),
  ];

  if (
    !kind &&
    !twin &&
    !ref &&
    !expect &&
    !target &&
    !description &&
    facts.length === 0 &&
    unreadable.length === 0
  ) {
    return undefined;
  }

  const routable = kind ? asCriterionKind(kind) : null;
  if (!routable) {
    return {
      why: kind
        ? `"${kind}" is not a criterion kind, so nothing could ever answer the condition — the ` +
          `whole vocabulary is ${CRITERION_KINDS.join(", ")}`
        : "it names no kind, so there is no question for a checker to answer",
    };
  }

  if (unreadable.length > 0) {
    return {
      why:
        `${unreadable.length} of the facts it declares did not arrive as text ` +
        `(${unreadable.map(showEntry).join(", ")}). \`adaptFacts\` is the list of literals a ` +
        `rewording must keep, and one nothing can read is one nothing enforces — the rewrite ` +
        `would be accepted whatever it dropped, including the figure this beat may be the only ` +
        `place the day says. Write each fact as its own short string in a list`,
    };
  }

  return {
    when: {
      description: description ?? "",
      // Trusted as far as the enum on the wire, and no further: an unknown twin
      // has no rule in @sonata/world's table, so `bindAdaptation` refuses it by
      // name rather than this file guessing which surface was meant.
      twin: (twin ?? "") as TwinName | "any",
      kind: routable,
      ...(ref ? { ref } : {}),
      ...(expect ? { expect } : {}),
      ...(target ? { target } : {}),
    },
    facts,
  };
}

/** One line for the timeline and the preview: who did what, on which surface. */
export function beatSummary(beat: AuthoredBeat, byName: Map<string, Person>): string {
  const who = beat.from ? (byName.get(beat.from.trim().toLowerCase())?.name ?? beat.from) : "The world";
  if (beat.kind === "email") return `${who} emails — "${beat.subject ?? "no subject"}"`;
  if (beat.kind === "message") return `${who} posts in #${(beat.channel ?? "general").replace(/^#/, "")}`;
  if (beat.kind === "invite") return `${who} invites everyone to "${beat.title ?? "a meeting"}"`;
  return `"${beat.eventRef ?? "a meeting"}" moves${beat.reason ? ` — ${beat.reason}` : ""}`;
}

/**
 * What this scenario is known to hold, and nothing it merely hopes for.
 *
 * Every number is counted off something that already exists in this process: the
 * cast and the channels were assembled above, in code, and the rest are the
 * day's own beats, which are written before anyone sees them. So these are
 * facts, and they stay true however the company's history turns out.
 *
 * What is deliberately absent is that history — the inbox, the Slack backlog and
 * the calendar the agent finds already there. Nothing here can know it:
 * @sonata/world writes it with a model call at SEED time, and `actualCounts`
 * counts the result, which is the number the world record then carries and the
 * only one anybody should print as the company's size.
 *
 * This function used to forecast it — `people * 2 + 4` threads, `channels * 8`
 * Slack messages — and the preview printed the forecast under the word
 * "exactly". The three previews still on record promised 19-20 threads and 35-38
 * emails; the six companies actually seeded hold 6-7 threads and 10-21 emails.
 * No arithmetic over the cast could have landed closer: the seeder is asked for
 * "5 to 8 threads" and "6 to 12 events" in prose, and obeys. On the screen where
 * someone commits two minutes, an unverifiable number is worse than no number.
 */
export function plannedCounts(seed: WorldSeed, beats: Beat[]): WorldCounts {
  const emails = beats.flatMap((b) => (b.twin === "gmail" && b.kind === "email" ? [b.payload] : []));
  return {
    people: seed.cast.length,
    // A reply lands on a thread that already exists; only a fresh email opens one.
    threads: emails.filter((p) => !p.inReplyTo).length,
    messages: emails.length,
    channels: seed.channels.length,
    slackMessages: beats.filter((b) => b.twin === "slack" && b.kind === "message").length,
    // `move` reschedules an invite an earlier beat already created, so it adds
    // nothing to the calendar.
    events: beats.filter((b) => b.twin === "calendar" && b.kind === "invite").length,
    // The same rule on the four later surfaces: count what the day CREATES, not
    // what it touches. An `update` edits a record that is already in the CRM, an
    // `append` writes into a document somebody else wrote, and a `comment` lands
    // under a post that was already published — none of them is a new row, and
    // counting them here would tell a user the day fills a CRM it only edits.
    records: beats.filter((b) => b.twin === "attio" && b.kind === "record").length,
    documents: beats.filter((b) => b.twin === "google-docs" && b.kind === "document").length,
    // Always 0, and correctly: an ads beat changes a campaign's status, its
    // budget or its spend, and there is no beat that opens one.
    campaigns: 0,
    posts: beats.filter((b) => b.twin === "linkedin" && b.kind === "post").length,
  };
}

/**
 * The beats a criterion is allowed to point at: the ones that survived assembly.
 *
 * Exported because `repairCriteria` in draft.ts needs the same list to build the
 * prompt it re-asks with, and it used to build its own copy. They have to agree:
 * one produces the refs and ticks the model is TOLD it may name, the other is the
 * gate that throws away what it names. A field on one copy and not the other — as
 * `tick` was — shows up as a model inventing deadlines with no schedule in front
 * of it and `bindCriteria` rejecting them, which reads like a bad model rather
 * than two lists that disagree.
 *
 * `tick` matters and is not decoration: it is the only thing that lets
 * `bindCriteria` catch a deadline EARLIER than the beat the criterion is about —
 * "reply to the t12 email before t4" — which no agent could ever satisfy.
 */
export function bindableBeats(beats: Beat[]): BindableBeat[] {
  return beats
    .filter((b): b is Beat & { ref: string } => Boolean(b.ref))
    .map((b) => ({ ref: b.ref, twin: b.twin, kind: b.kind, tick: b.tick }));
}

/**
 * A beat that will keep its authored wording, because its adaptation would never
 * have done anything.
 *
 * Not the same loss as an unbound criterion, and not silent for the same reason.
 * Nothing about the day's shape or its score changes — the beat fires on its tick
 * either way, which is the guarantee that made adaptation safe in the first place.
 * What is lost is that the beat will chase an agent that already answered, in the
 * words it was written with, in every run. That reads on the timeline as a feature
 * that simply did not happen, and it has to be attributable to the condition
 * rather than to the mechanism.
 */
export interface DroppedAdaptation {
  /** The beat that keeps its authored wording: its `ref`, or its id when it has none. */
  beat: string;
  tick: number;
  /** Reads as the second half of "…this beat could not adapt because …". */
  why: string;
}

export interface AssembledScenario {
  seed: WorldSeed;
  spec: EpisodeSpec;
  draft: ScenarioDraft;
  /** Adaptations thrown away, with the reason for each. Empty on a healthy day. */
  droppedAdaptations: DroppedAdaptation[];
  /**
   * Criteria that were thrown away because nothing could have checked them, with
   * the reason for each. Empty is the only acceptable steady state: the caller
   * regenerates on a non-empty one, and only says it out loud when regenerating
   * has stopped helping.
   *
   * `RejectedCriterion` rather than `UnboundCriterion` because one of the reasons
   * is now "that is not a kind", and that reason has to carry the word the model
   * actually used.
   */
  unbound: RejectedCriterion[];
}

export interface AssembleOptions {
  brief: string;
  ticks: number;
  simMinutesPerTick?: number;
  /** True when no model was involved — surfaced in the preview, not hidden. */
  offline: boolean;
  /** Why, when offline. Travels into the draft so the fallback is never silent. */
  offlineReason?: string;
}

/**
 * Authored scenario → WorldSeed + EpisodeSpec + the preview the modal renders.
 * Everything unresolvable is dropped, not guessed: a beat pointing at a channel
 * that does not exist would be a silent no-op three hours into a benchmark.
 */
export function assembleScenario(
  authored: AuthoredScenario,
  options: AssembleOptions,
): AssembledScenario {
  const domain = emailDomain(authored.business.name);
  // Paired rather than zipped by index further down: a persona needs `brief`,
  // `responsiveness` and `replyDelayTicks`, which live on the authored person and
  // not on `Person`, and holding the two together here is what stops a filter on
  // one list silently misaligning the other.
  const castMembers = authored.cast.map((p) => ({ authored: p, person: toPerson(p, domain) }));
  const cast = castMembers.map((m) => m.person);
  const byName = new Map(cast.map((p) => [p.name.trim().toLowerCase(), p]));
  const owner = byName.get(authored.owner.trim().toLowerCase()) ?? cast[0];
  if (!owner) throw new Error("a world needs at least one person in its cast");

  const channels = authored.channels.map((c) => {
    const name = c.name.replace(/^#/, "").trim();
    const members = c.members
      .map((m) => byName.get(m.trim().toLowerCase())?.id)
      .filter((m): m is string => !!m);
    return {
      id: `C${slug(name).replace(/-/g, "").toUpperCase().slice(0, 10)}`,
      name,
      purpose: c.purpose,
      // The mailbox owner is a member of anything they can read.
      members: members.includes(owner.id) ? members : [owner.id, ...members],
      isPrivate: c.isPrivate ?? false,
    };
  });

  const seed: WorldSeed = {
    business: {
      name: authored.business.name,
      description: authored.business.description,
      industry: authored.business.industry,
      size: authored.business.size,
    },
    cast,
    channels,
    mailboxOwner: owner.id,
  };

  const clock = nextWorkdayClock(options.ticks, options.simMinutesPerTick ?? 15);
  const channelNames = new Set(channels.map((c) => c.name));

  const sorted = [...authored.episode.beats].sort((a, b) => a.tick - b.tick);
  // Paired rather than zipped by index, for the same reason the cast is: the
  // adaptation pass below needs the authored beat and the assembled one together,
  // and a beat that `buildBody` refuses drops out of one list only.
  const built: Array<{ authored: AuthoredBeat; beat: Beat }> = [];
  const previews: BeatPreview[] = [];
  for (const authoredBeat of sorted) {
    const tick = Math.max(0, Math.min(Math.round(authoredBeat.tick), clock.ticks - 1));
    const body = buildBody({ ...authoredBeat, tick }, byName, channelNames, clock, owner.id);
    if (!body) continue;
    built.push({
      authored: authoredBeat,
      beat: {
        ...body,
        id: newId("beat"),
        tick,
        ...(authoredBeat.ref ? { ref: authoredBeat.ref } : {}),
        ...(authoredBeat.note ? { note: authoredBeat.note } : {}),
      },
    });
    previews.push({
      tick,
      timeLabel: tickLabel(clock, tick),
      twin: body.twin,
      kind: body.kind,
      summary: authoredBeat.note ?? beatSummary({ ...authoredBeat, tick }, byName),
    });
  }

  // One context, two gates. A condition and a criterion name the same refs, the
  // same channels and the same people, and both are answered by the judge's own
  // provider table — a second copy of any of that is a place for the two to
  // disagree about what "replied on `clive-first`" means.
  const binding: BindingContext = {
    beats: bindableBeats(built.map((b) => b.beat)),
    channels: channels.map((c) => c.name),
    person: (ref) => byName.get(ref.trim().toLowerCase())?.id,
    hasChecker: (twin, kind) => factNameFor(twin, kind) !== null,
  };

  // Adaptations second, and in their own pass, because a condition may name ANY
  // beat in the day — including one the loop above had not reached yet. Validating
  // inside the loop would refuse a perfectly good backward-looking condition on
  // half the beats and accept it on the other half, decided by author order.
  //
  // A refused adaptation costs the ADAPTATION and never the BEAT: the day's
  // schedule, and every criterion bound against it below, must not move because a
  // condition failed to parse.
  const droppedAdaptations: DroppedAdaptation[] = [];
  const beats: Beat[] = built.map(({ authored: authoredBeat, beat }) => {
    const parsed = authoredAdaptation(authoredBeat);
    if (!parsed) return beat;
    const outcome =
      "why" in parsed
        ? parsed
        : bindAdaptation(
            parsed,
            // `beatWords` is @sonata/engine's, and it is the same function the
            // rewrite itself calls: a beat kind it cannot read words off is a beat
            // that could never adapt, and this gate has to agree with the runtime
            // about which those are.
            { twin: beat.twin, kind: beat.kind, tick: beat.tick, words: beatWords(beat) ?? "" },
            { ...binding, missingFacts },
          );
    if ("why" in outcome) {
      droppedAdaptations.push({ beat: beat.ref ?? beat.id, tick: beat.tick, why: outcome.why });
      return beat;
    }
    return { ...beat, adapt: outcome.bound };
  });

  // Blank lines dropped, and anything word-for-word identical to a standing
  // prohibition dropped with them: the director renders these as a bulleted list,
  // and the same sentence twice reads as emphasis on the wrong rule.
  //
  // Anything that is not a line of prose is dropped the same way rather than
  // thrown over — a model answering a list-of-rules field with
  // `[{"rule": "..."}]`, or with one newline-separated string, is the single most
  // ordinary way for this field to come back wrong, and it must cost that field
  // and not the day. See `authoredText`.
  const authoredOffLimits = (Array.isArray(authored.offLimits) ? authored.offLimits : [])
    .map(authoredText)
    .filter((line): line is string => line !== undefined && !ALWAYS_OFF_LIMITS.includes(line));

  // The kind first, because everything after it assumes one that can be routed:
  // `bindCriteria` looks up a rule by `${twin}/${kind}` and the judge looks up a
  // checker the same way, so an unknown kind would fall out of both as an absent
  // table entry — the exact accident this pass exists to abolish. Rejected here,
  // by name, it becomes a repair the model is asked to make.
  const vetted = vetCriterionKinds(authored.episode.criteria);

  // Every criterion is bound against the day that actually assembled — these
  // beats, these channels, this cast — before the scenario exists. A criterion
  // that will not bind is dropped here rather than saved to be discovered as
  // "could not be checked" on a report someone is already sharing.
  const { bound, unbound: notBound } = bindCriteria(vetted.ok, binding);

  // One list, both reasons: a kind nothing can route, and a criterion that names
  // nothing to route it at. The repair loop and the judge questions below treat
  // them identically, because from the day's point of view they are the same
  // loss — a claim about this workday that nothing will ever answer.
  const unbound: RejectedCriterion[] = [...vetted.rejected, ...notBound];

  // Field by field, and not a spread, because `id` and `target` are rewritten and
  // a stray authored key must not reach the saved spec. The cost of that shape is
  // that a field added to `Criterion` is dropped here silently — it type-checks,
  // because every one of them is optional — so ANY new field must be added to
  // this list too. `before` is the standing example: `bindCriteria` validates the
  // deadline, `normalize` in @sonata/world deliberately keeps it, and then this
  // projection threw it away, so ordering worked in every test and in none of the
  // generated scenarios that are the only way it is ever authored.
  const checklist: Criterion[] = bound.map((c, index) => ({
    id: `c${index + 1}`,
    description: c.description,
    twin: c.twin,
    kind: c.kind,
    ...(c.ref ? { ref: c.ref } : {}),
    ...(c.before ? { before: c.before } : {}),
    ...(c.expect ? { expect: c.expect } : {}),
    ...(c.target ? { target: resolveRef(c.target, byName) ?? c.target } : {}),
    weight: c.weight ?? 1,
    severity: c.severity,
  }));

  const spec: EpisodeSpec = {
    id: newId("ep"),
    title: authored.episode.title,
    story: authored.episode.story,
    task: authored.episode.task,
    world: seed,
    clock,
    beats,
    director: {
      maxEventsPerTick: 2,
      // The owner is not a persona: the agent is already writing from that
      // mailbox, and a director that could answer as them would be answering
      // itself.
      personas: castMembers
        .filter((m) => m.person.id !== owner.id)
        .map((m) => personaFor(m.authored, m.person)),
      offLimits: [...ALWAYS_OFF_LIMITS, ...authoredOffLimits],
      style: authoredText(authored.style) ?? DEFAULT_STYLE,
    },
    success: {
      checklist,
      judgeQuestions: [
        "Did the agent connect what it read across the surfaces it had, or work one surface at a time?",
        "Where it handed something back to a human, could it have acted instead?",
        // A criterion nothing can check is not quietly forgotten: it leaves the
        // checklist, where it would have scored as an undecided free pass, and
        // arrives in front of the judge with the reason it could not be checked
        // attached — so the gap is on the report rather than under it.
        ...unbound.map(
          (c) =>
            `Nothing deterministic could check this, so it was dropped from the checklist ` +
            `(${c.severity}, ${c.twin}/${c.kind}; ${c.why}). Say plainly whether it happened: ` +
            `"${c.description}"`,
        ),
      ],
    },
    termination: guardsFor(clock),
  };

  const usedTwins = new Set<TwinName>(beats.map((b) => b.twin));
  for (const c of checklist) if (c.twin !== "any") usedTwins.add(c.twin);

  const draft: ScenarioDraft = {
    draftId: newId("draft"),
    brief: options.brief,
    createdAt: Date.now(),
    offline: options.offline,
    ...(options.offlineReason ? { offlineReason: options.offlineReason } : {}),
    business: {
      name: seed.business.name,
      industry: seed.business.industry,
      size: seed.business.size,
      description: seed.business.description,
    },
    counts: plannedCounts(seed, beats),
    cast: cast.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      email: p.email,
      relationship: p.relationship,
    })),
    channels: channels.map((c) => ({
      name: c.name,
      purpose: c.purpose,
      memberCount: c.members.length,
    })),
    episode: {
      title: spec.title,
      story: spec.story,
      task: spec.task,
      ticks: clock.ticks,
      simMinutesPerTick: clock.simMinutesPerTick,
      startISO: clock.startISO,
      // `TWIN_NAMES` rather than a list written out here: core derives the same
      // set for the run (`episodeTwins`), and a second hand-maintained list of
      // surfaces is how a preview comes to say "Gmail and Slack" about a day
      // that also files a note in the CRM — and how the run starts a twin the
      // person who pressed Run was never shown.
      twins: TWIN_NAMES.filter((t) => usedTwins.has(t)),
      beats: previews,
      criteria: checklist.map((c) => ({
        description: c.description,
        twin: c.twin,
        severity: c.severity,
      })),
    },
  };

  return { seed, spec, draft, unbound, droppedAdaptations };
}
