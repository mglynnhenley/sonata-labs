import type { Clock, Criterion, EpisodeSpec, TwinName } from "@sonata/core";
import { offsetMinutes, tickLabel } from "@sonata/core";
import { SERVICE_LABELS } from "@sonata/ui/tokens";

// The six-bullet work-and-measurement contract from docs/benchmark-realism-plan.md
// section 0, derived entirely from what an EpisodeSpec already carries plus the
// engine's constants. Nothing here is a new authoring field: where the spec does
// not separately declare a bullet, the contract says so in so many words rather
// than inventing content, so a practitioner reading the page can tell what is
// declared from what is merely implied by the brief.

/** The honest line for a bullet the format cannot yet state on its own. */
export const NOT_DECLARED = "authored in the brief; not separately declared";

export interface DeliverableRow {
  id: string;
  description: string;
  severity: Criterion["severity"];
  /** Label as the page prints it; "Any surface" for cross-surface criteria. */
  surface: string;
  /** "12:00", "before the handoff email fires (17:30)" or "by end of day". */
  deadline: string;
  /** How the run settles it: a deterministic check, or the judge. */
  settledBy: string;
}

export interface ContractGroup {
  heading?: string;
  items: string[];
}

export interface ContractSection {
  title: string;
  groups: ContractGroup[];
  /** Section 2 only: one row per checklist criterion. */
  deliverables?: DeliverableRow[];
}

export interface ScenarioContract {
  sections: [ContractSection, ContractSection, ContractSection, ContractSection, ContractSection, ContractSection];
}

const MS_PER_MINUTE = 60_000;
const UNMEASURED = /unmeasured/i;

function surfaceLabel(twin: TwinName | "any"): string {
  return twin === "any" ? "Any surface" : SERVICE_LABELS[twin];
}

/** The calendar date of the day, in the offset the spec's own clock declares. */
function dayOf(clock: Clock): string {
  const local = Date.parse(clock.startISO) + offsetMinutes(clock.startISO) * MS_PER_MINUTE;
  return new Date(local).toISOString().slice(0, 10);
}

function minutes(ms: number): string {
  const m = Math.round(ms / MS_PER_MINUTE);
  return m === 1 ? "1 minute" : `${m} minutes`;
}


/**
 * Renders `Criterion.before` the way the judge reads it: a beat ref first, and
 * `t<n>` only when no beat answers to that name. Anything else is the whole day.
 */
export function deadlineOf(criterion: Criterion, spec: EpisodeSpec): string {
  const before = criterion.before?.trim();
  if (!before) return "by end of day";
  const beat = spec.beats.find((b) => b.ref === before);
  if (beat) return `before "${before}" fires (${tickLabel(spec.clock, beat.tick)})`;
  const tick = /^t(\d+)$/.exec(before);
  if (tick) return tickLabel(spec.clock, Number(tick[1]));
  // The judge reads `before` the same two ways and gives up on anything else,
  // so the page must not dress an unknown name up as a deadline.
  return `before "${before}" (no beat by that name: the judge cannot settle this deadline)`;
}

function settledBy(criterion: Criterion): string {
  return criterion.kind === "judged"
    ? "judged from the final state and the day's messages"
    : `checked automatically (${criterion.kind})`;
}

export function buildContract(spec: EpisodeSpec, twins: TwinName[]): ScenarioContract {
  const { world, clock, director, success, termination } = spec;
  const owner = world.cast.find((person) => person.id === world.mailboxOwner);
  const personById = new Map(world.cast.map((person) => [person.id, person]));

  const role: ContractSection = {
    title: "Role, tools, responsibilities and permitted actions",
    groups: [
      {
        heading: "Role",
        items: [owner ? `The agent works as ${owner.name}, ${owner.role}.` : `The agent operates the accounts of "${world.mailboxOwner}", who is not in the cast.`],
      },
      {
        heading: "Tools",
        items: [twins.length ? `${twins.map((twin) => SERVICE_LABELS[twin]).join(", ")}: the surfaces this day's events and criteria touch.` : "No surface is touched by a beat or a criterion."],
      },
      { heading: "Responsibilities (the brief, handed over once at the start)", items: [spec.task] },
      { heading: "Permitted actions", items: [`Permitted actions are ${NOT_DECLARED}.`] },
    ],
  };

  const deliverables: DeliverableRow[] = success.checklist.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    severity: criterion.severity,
    surface: surfaceLabel(criterion.twin),
    deadline: deadlineOf(criterion, spec),
    settledBy: settledBy(criterion),
  }));
  const mustCount = deliverables.filter((row) => row.severity === "must").length;
  const deliverablesSection: ContractSection = {
    title: "Deliverables, deadlines and evidence of completion",
    groups: [
      {
        items: deliverables.length
          ? [`${deliverables.length} checklist criteria, ${mustCount} of them must-pass. A failed must fails the day; a failed should only costs score. Deadlines are read strictly: an action on the deadline's own tick is late.`]
          : ["No checklist criteria are declared; the day is scored on judge questions alone."],
      },
    ],
    deliverables,
  };

  const personas = director.personas.map((persona) => {
    const person = personById.get(persona.personId);
    const surfaces = persona.surfaces.map((twin) => SERVICE_LABELS[twin]).join(", ");
    const who = person ? `${person.name}, ${person.role}` : persona.personId;
    return `${who}: answers on ${surfaces || "no surface"}, ${persona.replyDelayTicks === 0 ? "within the same interval" : `${persona.replyDelayTicks} interval${persona.replyDelayTicks === 1 ? "" : "s"} later`}.`;
  });
  const review: ContractSection = {
    title: "Decisions requiring human review",
    groups: [
      {
        heading: "People who can decide (the world answers as them)",
        items: personas.length ? personas : ["No colleague answers the agent in this scenario; the day is the scripted events alone."],
      },
      {
        heading: "What the world will not do",
        items: director.offLimits.length ? director.offLimits : ["No off-limits list is declared."],
      },
      {
        heading: "Which decisions need a human, and what a useful review request contains",
        items: [`This is ${NOT_DECLARED}.`],
      },
    ],
  };

  const unmeasured = [
    ...success.checklist.filter((c) => UNMEASURED.test(c.description)).map((c) => `${c.id}: ${c.description}`),
    ...success.judgeQuestions.filter((q) => UNMEASURED.test(q)),
  ];
  const facts: ContractSection = {
    title: "Fictional reviewer instructions versus tested domain knowledge",
    groups: [
      {
        heading: "What the judge is asked",
        items: success.judgeQuestions.length ? success.judgeQuestions : [`No judge questions are declared. Which facts are fictional instruction and which knowledge is tested is ${NOT_DECLARED}.`],
      },
      {
        heading: "Declared unmeasured",
        items: unmeasured.length ? unmeasured : ["Nothing in this spec is marked unmeasured; treat every criterion as tested."],
      },
    ],
  };

  const ticks = spec.beats.map((beat) => beat.tick);
  const span = ticks.length ? `${tickLabel(clock, Math.min(...ticks))} to ${tickLabel(clock, Math.max(...ticks))}` : null;
  const events: ContractSection = {
    title: "Fixed events, action-dependent consequences and measurement limits",
    groups: [
      {
        heading: "Fixed background events",
        items: [
          span ? `${spec.beats.length} scheduled events from ${span}. They fire on schedule in every run, whatever the agent does.` : "No scheduled events; nothing arrives during the day unless the agent starts it.",
        ],
      },
      {
        heading: "Action-dependent consequences",
        items: [
          `Colleague replies are the only responses that depend on what the agent did, capped at ${director.maxEventsPerTick} improvised event${director.maxEventsPerTick === 1 ? "" : "s"} per interval. Nothing else branches.`,
        ],
      },
      {
        heading: "Known measurement limits",
        items: [
          "Reads are not audited: only tool calls that change a surface leave audit rows, so what the agent looked at is inferred from its own transcript, not proven.",
          "Inspect retains the tested model's calls and tool transcript. A separately connected external agent must provide its own transcript; Sonata's app audit alone cannot recover its reasoning or reads.",
        ],
      },
    ],
  };

  const guards = [
    `Wall-clock guard ${minutes(termination.maxWallClockMs)}.`,
    termination.maxCostUsd !== undefined ? `Spend guard $${termination.maxCostUsd} across captured agent and world calls, checked after calls finish. In-flight calls can exceed it; final judging is additional.` : "No spend guard is declared.",
    termination.maxTicks !== undefined ? `Hard cap ${Math.min(termination.maxTicks, clock.ticks)} ticks.` : null,
    termination.idleTicks > 0
      ? `${termination.idleTicks} consecutive quiet intervals raise a diagnostic note; silence never ends the day.`
      : "No idle diagnostic; silence never ends the day.",
    // The spec can ask for an early stop, but no caller of this harness
    // evaluates the checklist mid-day, so the day always runs to the end.
    termination.stopWhenAllMustPass
      ? "The spec asks to stop once every must criterion passes, but this harness does not evaluate the checklist mid-day, so the day runs to the end."
      : "The day runs to the end even when every must criterion has passed.",
  ].filter((line): line is string => line !== null);
  const harness: ContractSection = {
    title: "Harness, context assistance, work budget, clock policy and cost categories",
    groups: [
      {
        heading: "Inspect agent",
        items: [
          "Inspect runs the tested model and its tool loop. Its turn cap is a runaway backstop, not a measure of human work. The exact cap is recorded in the Inspect log. A no-tool reply waits for the next interval; finish_work stops agent actions while the world continues.",
          "Context assistance: Inspect trims the model's context while preserving the full transcript. The log records the compaction settings. No daily summary or additional memory is supplied by Sonata.",
          `Clock: ${clock.ticks} intervals of ${clock.simMinutesPerTick} simulated minutes, ${tickLabel(clock, 0)} to ${tickLabel(clock, clock.ticks)} on ${dayOf(clock)}. The default is compressed wall time at one simulated hour per real minute; model latency consumes business time.`,
          "A run may instead choose the experimental provider-operations-v1 clock, which charges the agent's own app requests so latency does not move business time. Each run saves the policy and charge allowance it used; the two are separate experimental conditions and their results are not comparable.",
        ],
      },
      { heading: "Termination guards", items: guards },
      {
        heading: "External agent (plugged in through a session)",
        items: [
          "Clock: compressed wall time unless the session requested provider-operations-v1. Under compression, model latency and tool startup consume business time, so timing results are labelled by their compression and are not a capability comparison.",
          "Work budget and context assistance belong to the external harness and are not declared here.",
        ],
      },
      {
        heading: "Cost categories",
        items: ["Agent, world (colleagues answering) and judge are reported separately. Inspect agent calls join the saved run's trace. Missing accounting is marked, never estimated; a separately connected external agent must supply its own cost record."],
      },
    ],
  };

  return { sections: [role, deliverablesSection, review, facts, events, harness] };
}
