import { isCriterionKind, type CriterionKind, type EpisodeSpec, type WorldSeed } from "@sonata/core";
import {
  AUTHORABLE_KINDS,
  CRITERIA_SCHEMA,
  CRITERION_SCHEMA,
  checklistShortfall,
  criteriaRules,
  type BindableBeat,
  type DraftCriterion,
} from "@sonata/world";
import {
  assembleScenario,
  type AssembledScenario,
  type AuthoredScenario,
  type RejectedCriterion,
} from "./authored";
import { completeJson, hasModelAccess } from "./llm";
import { getDoc, putDoc } from "./store";
import { TEMPLATES, assembleTemplate, type Template } from "./templates";
import type { ScenarioDraft } from "./types";

// One description in, one whole day out. This is the product's first promise —
// "type one description and get a full fake company" — so it is one model call,
// parked as a draft, and the Create button commits exactly what the preview
// showed. Previewing twice never costs twice, and the preview can never differ
// from what gets built.
//
// One thing is checked before the day is parked, and it is the checklist: a
// criterion that names no thread, no channel and no person cannot be checked by
// anything, and a day whose every `must` is unanswerable scores 100% while the
// agent sits on its hands. `bindCriteria` decides that in code, against the
// beats this day actually assembled, and `repairCriteria` below spends one more
// small model call rather than shipping the hole.

const SYSTEM = `You write simulation scenarios for testing AI agents inside a cloned business.

You are given a one-line description of a business and a day. You return ONE JSON object describing:
- the business (name, industry, headcount, one paragraph of what state it is in this week)
- a cast of 5-7 named people, including the person whose accounts the agent operates ("owner")
- 3 Slack channels the company actually uses
- an episode: the day as a story, the agent's standing brief, 5-8 scheduled beats, and 4-5 success criteria

Hard rules:
- Refer to people ONLY by their full name as written in the cast. Never write an email address, a Slack id, a user handle or an ISO timestamp — those are generated for you.
- Beats are scheduled by tick. Tick 0 is 09:00 and each tick is 15 simulated minutes.
- Beat kinds: {"twin":"gmail","kind":"email"} needs from/to/subject/body. {"twin":"slack","kind":"message"} needs from/channel/text, and channel must be one of the channels you listed. {"twin":"calendar","kind":"invite"} needs from/title/attendees/durationMinutes. {"twin":"calendar","kind":"move"} needs eventRef naming an earlier invite beat.
- Give a beat a short "ref" whenever a later beat or a criterion needs to point at it. Every beat a criterion is about MUST have one.
- The day must NOT be solvable by reading one message. Put a fact the agent needs on a different surface from where it is asked for, and make something change after the agent starts working.
- At least one beat must land in the second half of the day.
- Write like a real workplace: short, specific, slightly impatient. No lorem ipsum, no placeholder names like "John Doe".

${criteriaRules({ beats: [], channels: [], people: [] })}`;

// ---------------------------------------------------------------------------
// The kind enum the model is handed.
//
// @sonata/world derives `AUTHORABLE_KINDS` by splitting its rule table's
// `${twin}/${kind}` keys on "/", so a typo in a key would widen the enum the
// model is offered and make the typo authorable — which is one step from how
// `mentioned` got into a stored spec in the first place. It is intersected with
// @sonata/core's closed vocabulary here, so the enum on the wire is a subset of
// what the judge can route, whatever the rule table says.
//
// The drift is reported rather than swallowed: the schema is already correct by
// the time anyone reads the log, and the log is the only thing that will say the
// two lists have come apart.
// ---------------------------------------------------------------------------

const ROUTABLE_KINDS: CriterionKind[] = AUTHORABLE_KINDS.filter((k): k is CriterionKind =>
  isCriterionKind(k),
);
const UNROUTABLE_KINDS: string[] = AUTHORABLE_KINDS.filter((k) => !isCriterionKind(k));
if (UNROUTABLE_KINDS.length > 0) {
  console.error(
    `[sonata] @sonata/world offers criterion kinds @sonata/core does not define: ` +
      `${UNROUTABLE_KINDS.join(", ")}. They are excluded from the generation schema — nothing ` +
      `could route a criterion authored with one — but the two vocabularies have drifted.`,
  );
}

/** `CRITERION_SCHEMA` with `kind` pinned to the kinds the judge can actually route. */
const CRITERION_ITEM: Record<string, unknown> = {
  ...CRITERION_SCHEMA,
  properties: {
    ...CRITERION_SCHEMA.properties,
    kind: { type: "string", enum: ROUTABLE_KINDS },
  },
};

/** The same pinning, for the criteria-only repair call. */
const CRITERIA_ONLY_SCHEMA: Record<string, unknown> = {
  ...CRITERIA_SCHEMA,
  properties: {
    criteria: { ...CRITERIA_SCHEMA.properties.criteria, items: CRITERION_ITEM },
  },
};

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    business: {
      type: "object",
      properties: {
        name: { type: "string" },
        industry: { type: "string" },
        size: { type: "integer" },
        description: { type: "string" },
      },
      required: ["name", "industry", "size", "description"],
    },
    owner: { type: "string", description: "Full name of the cast member whose accounts the agent runs" },
    cast: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          relationship: {
            type: "string",
            description: "self, manager, peer, client, vendor, candidate",
          },
          voice: { type: "string", description: "How they write: length, register, quirks" },
        },
        required: ["name", "role", "relationship", "voice"],
      },
    },
    channels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Without the leading #" },
          purpose: { type: "string" },
          members: { type: "array", items: { type: "string" } },
        },
        required: ["name", "purpose", "members"],
      },
    },
    episode: {
      type: "object",
      properties: {
        title: { type: "string" },
        story: { type: "string" },
        task: { type: "string" },
        beats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tick: { type: "integer" },
              twin: { type: "string", enum: ["gmail", "slack", "calendar"] },
              kind: { type: "string", enum: ["email", "message", "invite", "move"] },
              ref: { type: "string" },
              note: { type: "string", description: "One line for the timeline; never shown to the agent" },
              from: { type: "string" },
              to: { type: "array", items: { type: "string" } },
              cc: { type: "array", items: { type: "string" } },
              subject: { type: "string" },
              body: { type: "string" },
              inReplyTo: { type: "string" },
              channel: { type: "string" },
              text: { type: "string" },
              title: { type: "string" },
              attendees: { type: "array", items: { type: "string" } },
              durationMinutes: { type: "integer" },
              eventRef: { type: "string" },
              reason: { type: "string" },
            },
            required: ["tick", "twin", "kind", "from"],
          },
        },
        // Every field required, unused ones sent as "" — the house pattern for
        // structured outputs. `ref`, `expect` and `target` were optional here
        // and the model simply left them out, which is how a checklist of
        // criteria that name nothing got authored in the first place.
        criteria: { type: "array", items: CRITERION_SCHEMA },
      },
      required: ["title", "story", "task", "beats", "criteria"],
    },
  },
  required: ["business", "owner", "cast", "channels", "episode"],
};

// ---------------------------------------------------------------------------
// Matching a brief to a shipped example.
//
// This is the whole judgement behind the offline fallback, and it used to have
// none: the scan started at `bestScore = -1`, so a brief sharing not one word
// with any template still came back as TEMPLATES[0]. "A nine-person bike repair
// chain, mid-recall" was answered with Northbeam Capital, treasury automation,
// twelve people. The screen said a template had been used; nothing said the
// template had nothing to do with the question.
// ---------------------------------------------------------------------------

/**
 * Words that appear in any business description and so distinguish none of them.
 *
 * Without this the score is mostly grammar: a veterinary practice scored 2
 * against the travel day on "with" and "four" — the same 2 a design agency at
 * quarter end scored against the invoice day on "quarter" and "invoices". No
 * floor can separate those, because the numbers are measuring different things.
 * Three groups, and each is here for a reason: function words carry syntax, not
 * subject; a headcount that coincides is not a subject in common; and the
 * furniture every workday brief mentions ("company", "week", "morning") is true
 * of all five templates at once.
 */
const UNDISTINGUISHING: ReadonlySet<string> = new Set(
  (
    "about after again against already also although always another anything around because " +
    "been before being between both cannot come comes could does doing done during each either " +
    "else even ever every everything from give gives going gone have having here however into " +
    "itself just keep keeps kind last later least less like made make makes many maybe mean " +
    "means might more most much must need needs never next none nothing only other others ought " +
    "over past perhaps please quite rather really same seem seems several shall should since " +
    "some someone something soon still such take takes than that their them then there these " +
    "they thing things this those though through thus told took under until upon used uses very " +
    "want wants well were what when where whether which while whole whom whose will with within " +
    "without would your yours " +
    "three four five seven eight nine multiple dozen " +
    "person people staff headcount " +
    "business businesses company companies firm team teams " +
    "week weeks weekly today tomorrow yesterday morning afternoon evening tonight hour hours " +
    "minute minutes"
  ).split(" "),
);

/** Words that carry meaning when matching a brief to a template. */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !UNDISTINGUISHING.has(w)),
  );
}

/**
 * How many distinct subject words a brief and a shipped example must share
 * before that example is allowed to stand in for the brief.
 *
 * Two — and what it means is "more than one word in common", which is the
 * smallest claim that is not a coincidence. Scored against the shipped five,
 * briefs that really are one of these days sit at 2 and above: a design agency
 * at quarter end meets the invoice day on "quarter, invoices"; a support desk
 * mid-outage meets the outage day on "checkout, customers, emailing,
 * engineering, fixing". Briefs about a bike repair chain, a bakery, a vet's and
 * a karate dojo all sit at exactly 0. What fills the gap between them is single
 * words: "engineering" alone tied a SOC 2 audit to an outage, "lands" alone tied
 * a logistics firm to a client escalation. So 1 is noise, 2 is the lowest number
 * the shipped templates give any evidence for, and a brief below it gets no
 * company rather than someone else's.
 */
const MATCH_FLOOR = 2;

export interface TemplateMatch {
  template: Template;
  /** The subject words the brief and the template actually have in common. */
  shared: string[];
}

/**
 * The shipped example that resembles this brief, or null when none does.
 *
 * Null is an answer, not a failure to produce one, and the caller may not paper
 * over it: below the floor, the nearest template is simply a different company
 * from the one the user described.
 */
export function nearestTemplate(brief: string): TemplateMatch | null {
  const wanted = keywords(brief);
  const scored = TEMPLATES.map((template) => {
    const have = keywords(`${template.title} ${template.description}`);
    return { template, shared: [...wanted].filter((w) => have.has(w)) };
  }).sort((a, b) => b.shared.length - a.shared.length);

  const best = scored[0];
  if (!best || best.shared.length < MATCH_FLOOR) return null;
  // A tie is not a match. Ties resolved by array position before, which is
  // exactly how an unrelated company got picked; when two shipped days fit a
  // description equally well, the user is the one who knows which they meant.
  if (scored[1] && scored[1].shared.length === best.shared.length) return null;
  return best;
}

/**
 * Nothing shipped resembles the brief, so nothing was built.
 *
 * Thrown rather than absorbed. Every other outcome of `draftScenario` hands back
 * a company, and handing back the wrong one under a footnote is the failure this
 * path exists to prevent — a user who has just described their business and been
 * given someone else's has been answered, not helped.
 */
export class NoResemblingExample extends Error {
  constructor(why: string) {
    super(
      `${why}. None of the ${TEMPLATES.length} shipped example days resembles the business you ` +
        `described, so none was substituted for it — an unrelated company presented as yours is ` +
        `worse than no company at all. Restore model access and preview again, or pick one of the ` +
        `shipped days knowing it is not your business.`,
    );
    this.name = "NoResemblingExample";
  }
}

/**
 * The one way this file falls back to a shipped day.
 *
 * All three failures below — no key, an answer too thin to run, an exception —
 * come through here, so what a user is told about a substitution cannot depend
 * on which of them happened. `offlineReason` names the substitution outright,
 * and the preview prints it beside the company's name, not in a footnote.
 */
export function templateStandIn(brief: string, ticks: number, why: string): AssembledScenario {
  const match = nearestTemplate(brief);
  if (!match) throw new NoResemblingExample(why);
  const business = match.template.scenario.business;
  return assembleTemplate(match.template, {
    ticks,
    offlineReason:
      `${why}. What is below is not your business: it is the shipped example ` +
      `"${match.template.title}" — ${business.name}, ${business.industry.toLowerCase()}, ` +
      `${business.size} people — matched to your description by ${match.shared.length} shared ` +
      `words: ${match.shared.join(", ")}.`,
  });
}

function looksUsable(scenario: AuthoredScenario): boolean {
  return (
    scenario.cast?.length >= 3 &&
    scenario.channels?.length >= 1 &&
    scenario.episode?.beats?.length >= 3 &&
    scenario.episode?.criteria?.length >= 2
  );
}

export interface DraftDoc {
  draft: ScenarioDraft;
  seed: WorldSeed;
  spec: EpisodeSpec;
  /**
   * Criteria that were dropped because nothing could have checked them. Present
   * and empty on a healthy day; a non-empty one is a hole in the scoring of this
   * scenario and is written into the record, warned about on the server, and
   * handed to the judge as a question rather than left to surface as a row
   * reading "could not be checked" on a report someone is sharing.
   *
   * `RejectedCriterion`, not `UnboundCriterion`: a criterion can now be dropped
   * for a kind nothing can route, and that reason has to carry the word the
   * model actually wrote — "mentioned" is the diagnosis, and it is not a
   * `CriterionKind`, so it cannot survive the narrower type.
   */
  unbound: RejectedCriterion[];
}

/**
 * How many times a checklist that does not bind is sent back. Two, because the
 * repair call is cheap (criteria only, against a day that already exists) and
 * because a model that has been shown the exact refs twice and still names none
 * is not going to find them on the third ask.
 */
const MAX_CRITERIA_REPAIRS = 2;

/** The day as the criteria author must see it: what exists to be named. */
function dayFacts(assembled: AssembledScenario): {
  beats: BindableBeat[];
  channels: string[];
  people: string[];
} {
  const beats: BindableBeat[] = assembled.spec.beats
    .filter((b): b is typeof b & { ref: string } => Boolean(b.ref))
    .map((b) => ({ ref: b.ref, twin: b.twin, kind: b.kind }));
  return {
    beats,
    channels: assembled.seed.channels.map((c) => c.name),
    people: assembled.seed.cast.map((p) => p.name),
  };
}

/**
 * Rewrite the checklist against the day that actually assembled.
 *
 * Only the criteria are asked for again. The business, the cast and the beats
 * were fine — regenerating the whole scenario would throw away a good day to fix
 * four sentences, and would produce a different day each time, so the preview
 * the user is waiting on would keep moving under them.
 */
async function repairCriteria(
  assembled: AssembledScenario,
  brief: string,
): Promise<DraftCriterion[]> {
  const facts = dayFacts(assembled);
  const kept = assembled.spec.success.checklist;
  const rejected = assembled.unbound;
  const shortfall = shortfallOf(assembled);

  const { criteria } = await completeJson<{ criteria: DraftCriterion[] }>({
    system:
      "You write the success criteria for a simulated workday. A criterion is checked by code " +
      "after the run, so it must name the exact thing it will be judged against.",
    user: [
      `THE DAY: ${assembled.spec.title} — ${assembled.spec.story}`,
      `THE AGENT'S BRIEF: ${assembled.spec.task}`,
      `THE BUSINESS THIS GREW FROM: ${brief}`,
      "",
      criteriaRules(facts),
      "",
      "These bound and are already correct. Return them unchanged, with the same refs:",
      ...kept.map(
        (c) =>
          `  ${c.twin}/${c.kind} [${c.severity}] ref="${c.ref ?? ""}" expect="${c.expect ?? ""}" ` +
          `target="${c.target ?? ""}" — ${c.description}`,
      ),
      "",
      ...(rejected.length
        ? [
            "These were REJECTED. Rewrite each one so it binds, or replace it with a different claim",
            "about the same part of the day — do not return it as it was:",
            ...rejected.map(
              (c) => `  ${c.twin}/${c.kind} — "${c.description}"\n    rejected: ${c.why}`,
            ),
            "",
          ]
        : []),
      // The other half of the ask. Every criterion binding is not the same thing
      // as the day being scored, and a checklist that is all `judged` binds.
      ...(shortfall ? [`ALSO WRONG WITH THIS CHECKLIST: ${shortfall}.`, ""] : []),
      "Return the whole checklist: the kept ones plus the rewrites, 3 to 6 in total.",
    ].join("\n"),
    schema: CRITERIA_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "sonata_criteria",
    maxTokens: 4000,
  });
  return Array.isArray(criteria) ? criteria : [];
}

/** Why this assembly would not score the day, or undefined when it would. */
function shortfallOf(s: AssembledScenario): string | undefined {
  return checklistShortfall(s.spec.success.checklist);
}

/**
 * Which of two assemblies scores more of the day.
 *
 * Criteria a CHECKER can settle come first, not criteria in total: a rewrite that
 * turns two rejected `must`s into two `judged` ones has more checklist and less
 * scoring, and taking it would be the whole bug in miniature.
 */
function better(a: AssembledScenario, b: AssembledScenario): AssembledScenario {
  const checked = (s: AssembledScenario) =>
    s.spec.success.checklist.filter((c) => c.kind !== "judged").length;
  if (checked(b) !== checked(a)) return checked(b) > checked(a) ? b : a;
  const bound = (s: AssembledScenario) => s.spec.success.checklist.length;
  if (bound(b) !== bound(a)) return bound(b) > bound(a) ? b : a;
  return b.unbound.length < a.unbound.length ? b : a;
}

/**
 * Assemble the day, and keep asking for a checklist that binds until it does.
 *
 * The loop is the point: validation happens BEFORE the scenario is stored, not
 * on the results page hours later. What survives it is a day whose every
 * criterion names a beat, a channel or a person that exists in it.
 */
async function assembleWithBoundCriteria(
  authored: AuthoredScenario,
  brief: string,
  ticks: number,
): Promise<AssembledScenario> {
  let scenario = authored;
  let best = assembleScenario(scenario, { brief, ticks, offline: false });

  for (
    let attempt = 1;
    attempt <= MAX_CRITERIA_REPAIRS && (best.unbound.length > 0 || shortfallOf(best));
    attempt += 1
  ) {
    let criteria: DraftCriterion[];
    try {
      criteria = await repairCriteria(best, brief);
    } catch {
      // A failed repair is not a failed day — the day is already assembled, and
      // what it costs is the criteria that would not bind. Stop asking.
      break;
    }
    if (criteria.length === 0) break;
    scenario = { ...scenario, episode: { ...scenario.episode, criteria } };
    best = better(best, assembleScenario(scenario, { brief, ticks, offline: false }));
  }

  if (best.unbound.length > 0) {
    // Loud on purpose. A dropped criterion is a piece of this day that nothing
    // will score, and the alternative — a silent drop — is what let a scenario
    // ship with four `must`s that no checker could ever answer.
    console.warn(
      `[sonata] "${best.spec.title}": ${best.unbound.length} criterion/criteria could not be ` +
        `bound to anything checkable and were dropped from the checklist:\n` +
        best.unbound.map((c) => `  - [${c.severity}] "${c.description}" — ${c.why}`).join("\n"),
    );
  }
  const shortfall = shortfallOf(best);
  if (shortfall) console.warn(`[sonata] "${best.spec.title}": ${shortfall}`);
  return best;
}

/**
 * The day as the model wrote it, or why it did not.
 *
 * Three ways this can come back a `why` and no day, and none of them decides
 * what happens next: that is `templateStandIn`'s single job, one level up. Three
 * failure branches each choosing their own fallback is the shape that let the
 * three of them drift into telling a user three different things.
 */
type Authored = { day: AssembledScenario } | { why: string };

async function authorFromModel(brief: string, ticks: number): Promise<Authored> {
  if (!hasModelAccess()) return { why: "OPENROUTER_API_KEY is not set, so no model could be asked" };

  try {
    const authored = await completeJson<AuthoredScenario>({
      system: SYSTEM,
      user: `Business and day to simulate:\n\n${brief}\n\nThe day runs for ${ticks} ticks, so ticks 0 to ${ticks - 1}.`,
      schema: SCHEMA,
      schemaName: "sonata_scenario",
      maxTokens: 16000,
    });
    if (!looksUsable(authored)) {
      return {
        why:
          `the model answered with too thin a business (${authored.cast?.length ?? 0} people, ` +
          `${authored.channels?.length ?? 0} channels, ${authored.episode?.beats?.length ?? 0} beats, ` +
          `${authored.episode?.criteria?.length ?? 0} criteria)`,
      };
    }

    const day = await assembleWithBoundCriteria(authored, brief, ticks);
    // The day cannot be scored: its criteria were dropped, or what survived is
    // prose for the judge. That is the same failure as a business too thin to
    // run — a day that will report 100% of nothing is not a day.
    const shortfall = shortfallOf(day);
    if (!shortfall) return { day };
    const dropped = day.unbound.map((c) => c.why).join("; ");
    return {
      why:
        `the model's criteria could not score this day, even after ${MAX_CRITERIA_REPAIRS} ` +
        `rewrites — ${shortfall}${dropped ? ` (dropped: ${dropped})` : ""}`,
    };
  } catch (err) {
    return { why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generate a world and a day from a plain-language brief, and park it.
 *
 * When the model cannot be reached it falls back to a shipped example, but only
 * to one that resembles what was described — and it says which, in the draft, so
 * the substitution reaches the screen the company is shown on. When nothing
 * resembles it, this throws: see `NoResemblingExample`.
 */
export async function draftScenario(brief: string, ticks: number): Promise<DraftDoc> {
  const authored = await authorFromModel(brief, ticks);
  const assembled = "day" in authored ? authored.day : templateStandIn(brief, ticks, authored.why);

  const doc: DraftDoc = {
    draft: { ...assembled.draft, brief },
    seed: assembled.seed,
    spec: assembled.spec,
    unbound: assembled.unbound,
  };
  putDoc("draft", doc.draft.draftId, doc);
  return doc;
}

export function getDraft(draftId: string): DraftDoc | undefined {
  return getDoc<DraftDoc>("draft", draftId);
}
