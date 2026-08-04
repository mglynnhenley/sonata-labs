import { completeJSON } from "../llm";
import { withRole } from "../trace";
import type { Contact } from "../types";
import type { Approach, Stage, StageCtx, ThreadContext } from "./types";

// Stage 5: weigh several angles on the scenario before committing to one. A
// one-shot generator writes the first framing that occurs to it, which is how a
// premise ends up staged on a thread that only half-supports it. Proposing N and
// keeping the losers is what lets `--explain` show what was considered.
//
// The model proposes; the *selection* is code (`selectApproach`). Same list in,
// same angle out — reproducible, and testable against a stubbed model.

const DEFAULT_COUNT = 3;

export interface OptionsInput {
  /** What stage 3 read off the winning thread, in the participants' own terms. */
  thread: ThreadContext;
  /** The real correspondent the scenario is bound to, from `bindContact`. */
  contact: Contact;
}

export interface OptionsResult {
  /** Every angle considered, in proposal order — the rejects are the audit trail. */
  approaches: Approach[];
  chosen: Approach;
}

export interface OptionsStageOptions {
  /** How many distinct angles to ask for. */
  count?: number;
}

const APPROACHES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["approaches"],
  properties: {
    approaches: {
      type: "array",
      description:
        "The requested number of angles, most promising first. Genuinely different " +
        "situations, not rewordings of one situation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "angle", "rationale", "plausibility"],
        properties: {
          id: {
            type: "string",
            description: "Short kebab-case handle, unique within the list, e.g. \"missed-deadline\".",
          },
          angle: {
            type: "string",
            description:
              "One sentence naming the concrete situation to stage on this thread.",
          },
          rationale: {
            type: "string",
            description: "Why this situation is believable given what the thread actually says.",
          },
          plausibility: {
            type: "number",
            description: "0..1. How believable this angle is on this thread. Score honestly.",
          },
        },
      },
    },
  },
} as const;

/**
 * Plausibility is the only field selection reads, and providers that only
 * soft-honour the schema return the odd NaN or 0-100 score, so pin it into range
 * rather than let a stray value walk off with the pick.
 */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Highest plausibility wins, ties broken by proposal order — the strict `>` keeps
 * the earlier entry, so an indifferent model still yields a stable choice.
 * Callers must pass a non-empty list; the stage's fallback is what guarantees it.
 */
export function selectApproach(approaches: Approach[]): Approach {
  return approaches.reduce((best, a) => (a.plausibility > best.plausibility ? a : best));
}

/**
 * Declared fallback. A thin mailbox or a model hiccup degrades the angle, never
 * the run: stage the scenario on exactly what the thread already left open. It is
 * the least inventive angle available and so the one most certain to be consistent.
 */
function fallbackApproach(ctx: StageCtx, thread: ThreadContext): Approach {
  return {
    id: "left-off",
    angle: `${ctx.scenario.title}, arising directly from where this thread stopped: ${thread.leftOffAt}`,
    rationale: `Derived in code from the thread's own open state (${thread.owes}), with no angle proposed.`,
    plausibility: 0.5,
  };
}

/**
 * Build the options stage. `count` is the number of angles proposed, not the
 * number kept — every one is returned so a weak scenario can be traced back to a
 * field of weak candidates rather than a bad pick.
 */
export function optionsStage(
  opts: OptionsStageOptions = {},
): Stage<OptionsInput, OptionsResult> {
  const count = Math.max(1, opts.count ?? DEFAULT_COUNT);

  return {
    name: "options",

    async run({ thread, contact }, ctx) {
      // Injected clock, never Date.now() — the model is told today only so it does
      // not propose an angle whose premise is already in the past.
      const today = new Date(ctx.now).toISOString().slice(0, 10);

      let proposed: Approach[] = [];
      try {
        const res = await withRole("generator", () =>
          completeJSON<{ approaches: Approach[] }>({
            system:
              "You design test scenarios for an email-triage evaluation harness. Scenarios are " +
              "staged in a local, offline sandbox mailbox to measure how an AI triage agent " +
              "handles difficult mail. Nothing you propose is ever sent to anyone.\n\n" +
              "You are given one real thread, and a scenario that must be staged ON that thread. " +
              "An angle is only worth proposing if the thread's own history makes it believable — " +
              "it calls in a debt the thread created, reopens a question it left open, or " +
              "escalates something it already started. Describe the situation, not its timing: " +
              "dates are assigned downstream from the thread's real timestamps. Score honestly; " +
              "a low score on a weak angle is worth more than a flattering one.",
            prompt:
              `TODAY: ${today}\n\n` +
              `SCENARIO TO STAGE: ${ctx.scenario.title}\n` +
              `WHAT MAKES IT HARD: ${ctx.scenario.difficulty}\n\n` +
              `THE REAL THREAD IT MUST BE STAGED ON\n` +
              `  What it is about: ${thread.summary}\n` +
              `  Where it left off: ${thread.leftOffAt}\n` +
              `  Who owes whom what: ${thread.owes}\n` +
              `  Still open: ${thread.openQuestions.join("; ") || "(nothing explicit)"}\n` +
              `  Tone: ${thread.tone}\n\n` +
              `WHO WILL SEND THE NEW MESSAGE\n` +
              `  ${contact.name} <${contact.email}> — ${contact.relationship}\n` +
              `  How they write: ${contact.styleNotes}\n\n` +
              `Propose ${count} distinct angles for staging this scenario on this thread, and ` +
              `rate how plausible each one is here.`,
            schema: APPROACHES_SCHEMA as unknown as Record<string, unknown>,
            schemaName: "scenario_approaches",
            model: ctx.model("options"),
            effort: "medium",
          }),
        );
        proposed = res.approaches ?? [];
      } catch (err) {
        ctx.say(`options: proposal call failed (${(err as Error).message})`);
      }

      const approaches: Approach[] = proposed
        .filter((a) => a.angle && a.angle.trim())
        .map((a, i) => ({
          // Ids are what `--explain` and the trace refer to an angle by, so an
          // omitted one gets a positional handle rather than an empty label.
          id: a.id && a.id.trim() ? a.id.trim() : `angle-${i + 1}`,
          angle: a.angle.trim(),
          rationale: a.rationale ? a.rationale.trim() : "",
          plausibility: clamp01(a.plausibility),
        }));

      if (approaches.length === 0) {
        approaches.push(fallbackApproach(ctx, thread));
        ctx.say("options: no usable angle proposed — staging on the thread's open state");
      }

      const chosen = selectApproach(approaches);
      ctx.say(
        `options: ${approaches.length} angle(s) considered, chose "${chosen.id}" ` +
          `(${chosen.plausibility.toFixed(2)}) — ${chosen.angle}`,
      );
      return { approaches, chosen };
    },
  };
}
