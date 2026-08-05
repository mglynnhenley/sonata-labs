import type { EpisodeSpec, WorldSeed } from "@sonata/core";
import {
  CRITERIA_SCHEMA,
  CRITERION_SCHEMA,
  checklistShortfall,
  criteriaRules,
  type BindableBeat,
  type DraftCriterion,
  type UnboundCriterion,
} from "@sonata/world";
import { assembleScenario, type AssembledScenario, type AuthoredScenario } from "./authored";
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
   */
  unbound: UnboundCriterion[];
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
        schema: SCHEMA,
        schemaName: "sonata_scenario",
        maxTokens: 16000,
      });
      if (looksUsable(authored)) {
        assembled = await assembleWithBoundCriteria(authored, brief, ticks);
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
          assembled = assembleTemplate(nearestTemplate(brief), reason);
        }
      } else {
        reason =
          `the model answered with too thin a business (${authored.cast?.length ?? 0} people, ` +
          `${authored.channels?.length ?? 0} channels, ${authored.episode?.beats?.length ?? 0} beats, ` +
          `${authored.episode?.criteria?.length ?? 0} criteria)`;
        assembled = assembleTemplate(nearestTemplate(brief), reason);
      }
    } catch (err) {
      // A generation failure must not cost the user their place in the flow —
      // but it must say what happened.
      reason = err instanceof Error ? err.message : String(err);
      assembled = assembleTemplate(nearestTemplate(brief), reason);
    }
  } else {
    reason = "OPENROUTER_API_KEY is not set, so no model could be asked";
    assembled = assembleTemplate(nearestTemplate(brief), reason);
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
