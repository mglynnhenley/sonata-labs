import type { EpisodeSpec, WorldSeed } from "@sonata/core";
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
- Give a beat a short "ref" when a later beat or a criterion needs to point at it.
- The day must NOT be solvable by reading one message. Put a fact the agent needs on a different surface from where it is asked for, and make something change after the agent starts working.
- At least one beat must land in the second half of the day.
- Criteria are written as outcomes, not actions. Use kinds: replied, sent, posted, scheduled, moved, untouched, mentions, no-escalation, judged. Two or three should be severity "must".
- Write like a real workplace: short, specific, slightly impatient. No lorem ipsum, no placeholder names like "John Doe".`;

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
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              twin: { type: "string", enum: ["gmail", "slack", "calendar", "any"] },
              kind: {
                type: "string",
                enum: [
                  "replied",
                  "sent",
                  "posted",
                  "scheduled",
                  "moved",
                  "untouched",
                  "mentions",
                  "no-escalation",
                  "judged",
                ],
              },
              ref: { type: "string" },
              expect: { type: "string" },
              target: { type: "string" },
              severity: { type: "string", enum: ["must", "should"] },
            },
            required: ["description", "twin", "kind", "severity"],
          },
        },
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
        assembled = assembleScenario(authored, { brief, ticks, offline: false });
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
  };
  putDoc("draft", doc.draft.draftId, doc);
  return doc;
}

export function getDraft(draftId: string): DraftDoc | undefined {
  return getDoc<DraftDoc>("draft", draftId);
}
