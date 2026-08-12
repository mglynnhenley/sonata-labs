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
  bindableBeats,
  RELATIONSHIPS,
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

// ---------------------------------------------------------------------------
// Characters.
//
// `voice` says how someone types; `brief` says how they behave. Only the second
// makes two people different people — and until it was asked for, a generated
// persona WAS three if-statements on `relationship` with no brief at all, so six
// people out of the same company were interchangeable on the page.
//
// The four examples are quoted verbatim from packages/scenarios'
// client-escalation, which is the hand-written bar, and they are here in full on
// purpose: a model matches an example far more reliably than it matches an
// adjective, and "write a specific brief" comes back as the same beige paragraph
// every time. Whatever else is edited here, the examples earn their tokens.
// ---------------------------------------------------------------------------

const CHARACTER_RULES = `CHARACTERS. Two fields, and they are not the same job:
- "voice" is how someone TYPES: length, register, punctuation, sign-off.
- "brief" is how someone BEHAVES: what they want, what they will accept, and what they will never do.

A cast with voices and no briefs is one person wearing six hats. Write each brief in the third person, one to three sentences, about THIS day. Make it decidable: someone holding a reply should be able to say whether this person would have sent it.

This is the bar — four real briefs from a hand-written day (the agent runs Nadia's accounts; Clive is the client):
- Clive: "Wants a time and a decision, in that order. Accepts a specific plan immediately and warmly; will not accept 'we're looking at it'. Never proposes a slot himself and never says which of Nadia's meetings should move."
- Bea: "Relieved by anything concrete. Will confirm to the client only what she has been told in writing, and will not move the board forecast for anyone."
- Theo: "Defends the locked grade for a while, then agrees. Restates the 15:00 machine deadline rather than solving the timing."
- Moira: "Answers only about the embargo clock. Confirms receipt in one line and holds the 16:00 send regardless."

Every one of them has a thing they want, a thing they will accept, and a thing they will never do. The last is load-bearing: it is what stops the world solving the day on the agent's behalf. Those four work somewhere else: match how specific they are, and use none of their names.

- "responsiveness": 0 to 1 — how likely they are to answer at all when addressed. 0.9 is someone waiting on you; 0.5 is someone who often just does not reply.
- "replyDelayTicks": 0 to 4 — ticks between being addressed and answering. 0 is straight back, 2 is half an hour. Vary these across the cast; a company where everyone answers instantly has no pressure in it.`;

const WORLD_RULES = `OFF LIMITS AND STYLE, for the company as a whole:
- "offLimits": 3 to 6 lines. Facts nobody in this world may volunteer, and moves nobody may make. Each line should name something that, if a person here said or did it, would hand the agent the answer or do the job for it — the clash it has to find for itself, the reply it has to write, the summary of what is still outstanding. Write them about THIS day, in the manner of: "Nobody mentions that the grade review and the Q3 forecast are both at 14:00 — the clash exists on the calendar and has to be found there." / "Nobody offers to move a meeting, and nobody proposes a new time for the client call." / "Nobody summarises the day, lists what is outstanding, or points out that the first email was never answered."
- "style": one or two sentences on the register everyone writes in, naming the surfaces where it differs, in the manner of: "Agency register. Slack is lower case, fragmentary, no sign-offs, two lines at most. Email is friendly, complimentary and completely immovable. Nobody writes a status report; nobody is ever more than four sentences long."`;

const SYSTEM = `You write simulation scenarios for testing AI agents inside a cloned business.

You are given a one-line description of a business and a day. You return ONE JSON object describing:
- the business (name, industry, headcount, one paragraph of what state it is in this week)
- a cast of 5-7 named people, including the person whose accounts the agent operates ("owner"), each with a real character
- 3 Slack channels the company actually uses
- how this world behaves: what nobody in it may say or do, and the register everyone writes in
- an episode: the day as a story, the agent's standing brief, 5-8 scheduled beats, and 4-5 success criteria

Hard rules:
- Refer to people ONLY by their full name as written in the cast. Never write an email address, a Slack id, a user handle or an ISO timestamp — those are generated for you.
- Beats are scheduled by tick. Tick 0 is 09:00 and each tick is 15 simulated minutes.
- Beat kinds: {"twin":"gmail","kind":"email"} needs from/to/subject/body. {"twin":"slack","kind":"message"} needs from/channel/text, and channel must be one of the channels you listed. {"twin":"calendar","kind":"invite"} needs from/title/attendees/durationMinutes. {"twin":"calendar","kind":"move"} needs eventRef naming an earlier invite beat.
- Give a beat a short "ref" whenever a later beat or a criterion needs to point at it. Every beat a criterion is about MUST have one.
- The day must NOT be solvable by reading one message. Put a fact the agent needs on a different surface from where it is asked for, and make something change after the agent starts working.
- At least one beat must land in the second half of the day.
- Write like a real workplace: short, specific, slightly impatient. No lorem ipsum, no placeholder names like "John Doe".

${CHARACTER_RULES}

${WORLD_RULES}

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

/**
 * The whole scenario as the model must return it.
 *
 * Exported so a test can hold its convention to account: every field required,
 * unused ones sent as "". `ref`, `expect` and `target` were optional once and the
 * model simply left them out, which is how a checklist of criteria that named
 * nothing got authored — and `brief` is that same field in a different coat, the
 * one whose absence turns a cast back into a list of names.
 */
export const SCENARIO_SCHEMA: Record<string, unknown> = {
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
          // An enum, from the assembler's own vocabulary, because this field is
          // not a label: `surfacesFor` reads it to decide who may appear in
          // Slack at all. As a description with six suggested values it was a
          // hint, and a model that answered "Client" or "external client" got a
          // person outside the company handed the company's Slack.
          relationship: {
            type: "string",
            enum: [...RELATIONSHIPS],
            description:
              "How they stand to the mailbox owner. client, vendor and candidate are OUTSIDE the company and are only ever reachable by email.",
          },
          voice: { type: "string", description: "How they TYPE: length, register, quirks" },
          brief: {
            type: "string",
            description:
              "How they BEHAVE, and not a restatement of voice: what they want, what they will accept, and what they will never do. One to three sentences, third person.",
          },
          responsiveness: {
            type: "number",
            description: "0 to 1 — how likely they are to answer at all when addressed.",
          },
          replyDelayTicks: {
            type: "integer",
            description: "0 to 4 — ticks between being addressed and answering. 0 is straight back.",
          },
        },
        required: ["name", "role", "relationship", "voice", "brief", "responsiveness", "replyDelayTicks"],
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
    offLimits: {
      type: "array",
      items: { type: "string" },
      description:
        "3 to 6 lines. Facts nobody in this world may volunteer and moves nobody may make — the things that would hand the agent the answer.",
    },
    style: {
      type: "string",
      description: "The register everyone here writes in, per surface where it differs.",
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
  required: ["business", "owner", "cast", "channels", "offLimits", "style", "episode"],
};

/** Words that carry meaning when matching a brief to a template. */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Closest shipped template to what the user described. Used when there is no
 * model access, so the flow still ends in a real, runnable day rather than an
 * error dialog — with `offline` set, and the UI says so.
 */
export function nearestTemplate(brief: string): Template {
  const wanted = keywords(brief);
  let best = TEMPLATES[0]!;
  let bestScore = -1;
  for (const template of TEMPLATES) {
    const have = keywords(`${template.title} ${template.description}`);
    let score = 0;
    for (const word of wanted) if (have.has(word)) score += 1;
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }
  return best;
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
  return {
    // The same function the binding gate uses, not a second copy of the map: this
    // list tells the model which refs and ticks it may name, and `bindCriteria`
    // throws away anything it names that is not on that list. Two copies drift
    // silently — one field short here and the model is asked for deadlines with
    // no schedule to pick from.
    beats: bindableBeats(assembled.spec.beats),
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
 * Say so when a generated cast reached the director with no characters in it.
 *
 * A missing brief is not worth falling back to a template over: the day still
 * runs, and `personaFor` derives a workable persona from the relationship. But
 * that derivation is exactly the flat world this schema exists to end, and its
 * only symptom is six people who sound the same, three screens and one model
 * spend later. The preview cannot show it — briefs are not on it — so this is
 * the one place the gap can be named at the moment it happens.
 *
 * Counted off the assembled personas rather than the raw JSON, because those are
 * what the director will actually be handed: a brief that arrived as a number or
 * a list is absent by the time it matters, and counting it as present here would
 * make this warning lie in exactly the case it exists for. `personaFor` is the
 * only thing that decides what a brief is.
 */
function warnIfCharacterless(assembled: AssembledScenario): void {
  const personas = assembled.spec.director.personas;
  if (personas.some((p) => p.brief)) return;
  console.warn(
    `[sonata] "${assembled.seed.business.name}": the model returned no usable character briefs, ` +
      `so every persona falls back to the relationship derivation and the cast will read as one ` +
      `person in ${personas.length} fonts.`,
  );
}

/**
 * Generate a world and a day from a plain-language brief, and park it. Falls back
 * to the nearest template — never to an error — because the preview step is the
 * moment the product has to feel effortless.
 */
export async function draftScenario(brief: string, ticks: number): Promise<DraftDoc> {
  let assembled: AssembledScenario;
  // Why the model was not used. Carried into the draft rather than swallowed: a
  // fallback the user cannot see is indistinguishable from the product working.
  let reason: string | undefined;

  if (hasModelAccess()) {
    try {
      const authored = await completeJson<AuthoredScenario>({
        system: SYSTEM,
        user: `Business and day to simulate:\n\n${brief}\n\nThe day runs for ${ticks} ticks, so ticks 0 to ${ticks - 1}.`,
        schema: SCENARIO_SCHEMA,
        schemaName: "sonata_scenario",
        maxTokens: 16000,
      });
      if (looksUsable(authored)) {
        assembled = await assembleWithBoundCriteria(authored, brief, ticks);
        // Before the shortfall check below can swap the day for a template: this
        // is a statement about what the MODEL wrote, and a template has no
        // briefs either, so warning after the swap would blame the model for the
        // fallback's flatness.
        warnIfCharacterless(assembled);
        // The day cannot be scored: its criteria were dropped, or what survived
        // is prose for the judge. That is the same failure as a business too thin
        // to run — say so and hand back a day that scores, rather than one that
        // will report 100% of nothing. Every shipped template clears this bar,
        // so the fallback is always a day whose verdict means something.
        const shortfall = shortfallOf(assembled);
        if (shortfall) {
          const why = assembled.unbound.map((c) => c.why).join("; ");
          reason =
            `the model's criteria could not score this day, even after ${MAX_CRITERIA_REPAIRS} ` +
            `rewrites — ${shortfall}${why ? ` (dropped: ${why})` : ""}`;
          assembled = assembleTemplate(nearestTemplate(brief), { ticks, offlineReason: reason });
        }
      } else {
        reason =
          `the model answered with too thin a business (${authored.cast?.length ?? 0} people, ` +
          `${authored.channels?.length ?? 0} channels, ${authored.episode?.beats?.length ?? 0} beats, ` +
          `${authored.episode?.criteria?.length ?? 0} criteria)`;
        assembled = assembleTemplate(nearestTemplate(brief), { ticks, offlineReason: reason });
      }
    } catch (err) {
      // A generation failure must not cost the user their place in the flow —
      // but it must say what happened.
      reason = err instanceof Error ? err.message : String(err);
      assembled = assembleTemplate(nearestTemplate(brief), { ticks, offlineReason: reason });
    }
  } else {
    reason = "OPENROUTER_API_KEY is not set, so no model could be asked";
    assembled = assembleTemplate(nearestTemplate(brief), { ticks, offlineReason: reason });
  }

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
