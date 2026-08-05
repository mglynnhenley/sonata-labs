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
  },
  "gmail/archived": {
    refBeatKinds: ["email"],
    names: "the email beat whose thread must leave the inbox",
  },
  "gmail/mentions": { needsExpect: "phrase", names: "the phrase the agent must write in an email" },
  "slack/posted": { needsExpect: "channel", names: "the channel the agent must post in" },
  "slack/sent": { needsPerson: true, names: "the person who must receive a DM" },
  "slack/replied": {
    refBeatKinds: ["message"],
    names: "the Slack message beat whose thread the reply must land in",
  },
  "slack/mentions": { needsExpect: "phrase", names: "the phrase the agent must write in Slack" },
  "calendar/scheduled": {
    needsExpect: "title",
    names: "words from the title of the meeting that must exist afterwards",
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
  "any/labelled": {
    refBeatKinds: ["email"],
    needsExpect: "label",
    names: "the email beat, and the label its thread must carry",
  },
  "any/archived": {
    refBeatKinds: ["email"],
    names: "the email beat whose thread must leave the inbox",
  },
  "any/scheduled": {
    needsExpect: "title",
    names: "words from the title of the meeting that must exist afterwards",
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
 * The criteria half of a generation prompt. Written as instructions to whoever
 * is authoring the day, and rendered against the real beats and channels so the
 * model is choosing from what exists rather than inventing a ref.
 */
export function criteriaRules(ctx: {
  beats: BindableBeat[];
  channels: string[];
  people: string[];
}): string {
  const beats = ctx.beats.length
    ? ctx.beats.map((b) => `    ${b.ref} — the ${b.twin} ${b.kind} beat`).join("\n")
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

// ---------------------------------------------------------------------------
// The wire schema. House pattern for structured outputs: no optional fields —
// every property is required and unused ones are the empty string, which the
// binder reads back as absent. A model that may omit `ref` omits it.
// ---------------------------------------------------------------------------

export const CRITERION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "twin", "kind", "ref", "expect", "target", "severity"],
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
