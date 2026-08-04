import { checklistScore, type CriterionResult, type TickRecord } from "@sonata/core";

// The headline number: how much of the job got done without a human stepping in.
//
// It is deliberately NOT a model's opinion. The judge returns its own
// `autonomyScore` and that is worth having — a wide gap between the two is the
// signal that the catalog is missing a mode — but the number quoted in the
// benchmark table has to be reproducible from the saved artifact, on a laptop,
// months later, with no key. So this is arithmetic over a run's shape.
//
// It is also not `score.autonomyScore` from @sonata/core, and the two are not
// rivals. That one is a penalty model over judge findings: checklist minus a
// deduction per autonomy-category finding, computable the moment a judge report
// exists. This one reads the run itself, which lets it see three things findings
// cannot count — how often the agent handed back relative to how often it acted,
// how much of the day it spent silent while work was waiting, and whether it read
// the answers to its own questions. Core's is the judge-side view; this is the
// run-side view, and the results page shows this one with its components open.
//
// Four components, each 0..1 and oriented so higher is always better:
//
//   completion     what actually got done, weighted by the spec's own criteria
//   independence   how often it acted rather than handing back
//   momentum       how much of the working day it spent silent with work waiting
//   follow-through whether it came back after the world answered it
//
// A component with nothing to measure is DROPPED and its weight redistributed,
// never scored as a free 1 — a day where nobody ever answered the agent must not
// hand it full marks for follow-through it never demonstrated.

export type AutonomyComponentId = "completion" | "independence" | "momentum" | "follow-through";

export interface AutonomyComponent {
  id: AutonomyComponentId;
  label: string;
  /** 0..1, oriented so higher is better. */
  value: number;
  /** Share of the final score, after inapplicable components were redistributed. */
  weight: number;
  /** The arithmetic in words, so the UI can open the number onto its reason. */
  detail: string;
}

/** The raw counts every component is derived from. Shown under the breakdown. */
export interface AutonomyStats {
  ticks: number;
  /** Ticks from the first thing arriving to the end of the day — its chances to act. */
  actionableTicks: number;
  /** Actionable ticks inside a run of two or more consecutive silent ones. */
  stallTicks: number;
  longestStall: number;
  /** Tool calls that changed a surface, failures included — an attempt is not a stall. */
  actions: number;
  reads: number;
  escalations: number;
  /** Times the world came back to the agent early enough for it to respond. */
  exchanges: number;
  exchangesCarried: number;
}

export interface AutonomyBreakdown {
  /** 0..1. The number on the results page. */
  score: number;
  components: AutonomyComponent[];
  stats: AutonomyStats;
}

const BASE_WEIGHTS: Record<AutonomyComponentId, number> = {
  completion: 0.45,
  independence: 0.25,
  momentum: 0.2,
  "follow-through": 0.1,
};

function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}

function pct(n: number): string {
  return `${Math.round(clamp01(n) * 100)}%`;
}

interface TickShape {
  tick: number;
  arrivals: number;
  actions: number;
  escalations: number;
}

function shapeOf(t: TickRecord): TickShape {
  let actions = 0;
  let escalations = 0;
  for (const s of t.agentSteps) {
    if (s.kind === "tool") actions += 1;
    else if (s.kind === "escalation") escalations += 1;
  }
  return {
    tick: t.tick,
    arrivals: t.beatsFired.length + t.directorEvents.length,
    actions,
    escalations,
  };
}

/**
 * Ticks the agent could reasonably have worked in: everything from the first thing
 * the world put in front of it to the end of the day. Before that first arrival
 * there was genuinely nothing to do, and counting those ticks as silence would
 * punish an episode whose story starts at 10am.
 */
function actionableWindow(shapes: TickShape[]): TickShape[] {
  const first = shapes.findIndex((s) => s.arrivals > 0);
  return first < 0 ? [] : shapes.slice(first);
}

/**
 * Stall ticks: actionable ticks inside a run of two or more consecutive silent
 * ones. A single quiet tick is a pause — an agent that acts every other tick is
 * working, not stalling — but two in a row while the day moves is the failure the
 * catalog calls `stalled`.
 */
function stallsIn(window: TickShape[]): { stallTicks: number; longest: number } {
  let stallTicks = 0;
  let longest = 0;
  let run = 0;

  const close = () => {
    if (run >= 2) {
      stallTicks += run;
      longest = Math.max(longest, run);
    }
    run = 0;
  };

  for (const s of window) {
    if (s.actions === 0 && s.escalations === 0) run += 1;
    else close();
  }
  close();
  return { stallTicks, longest };
}

/**
 * How often the world came back to the agent, and how often the agent came back to
 * it. An exchange is a director event answering a specific agent step; the agent
 * carried it if it took any action on a LATER tick, since the director speaks at the
 * end of a tick and the agent's next chance is the one after.
 *
 * Exchanges landing on the final tick are excluded from both counts: the agent was
 * never given a tick in which to answer them, and scoring an impossibility is how a
 * metric stops meaning anything.
 */
function exchangesIn(shapes: TickShape[], ticks: TickRecord[]): { total: number; carried: number } {
  const lastTick = shapes.length === 0 ? -1 : shapes[shapes.length - 1].tick;
  const actedAfter = (tick: number) => shapes.some((s) => s.tick > tick && s.actions > 0);

  let total = 0;
  let carried = 0;
  for (const t of ticks) {
    for (const e of t.directorEvents) {
      if (e.becauseSeq === undefined || t.tick >= lastTick) continue;
      total += 1;
      if (actedAfter(t.tick)) carried += 1;
    }
  }
  return { total, carried };
}

export function autonomy(checklist: CriterionResult[], ticks: TickRecord[]): AutonomyBreakdown {
  const shapes = ticks.map(shapeOf);
  const window = actionableWindow(shapes);
  const { stallTicks, longest } = stallsIn(window);
  const { total: exchanges, carried } = exchangesIn(shapes, ticks);

  let actions = 0;
  let reads = 0;
  let escalations = 0;
  for (const t of ticks) {
    for (const s of t.agentSteps) {
      if (s.kind === "escalation") escalations += 1;
      else if (s.kind === "tool" && s.isMutation) actions += 1;
      else if (s.kind === "tool") reads += 1;
    }
  }

  const stats: AutonomyStats = {
    ticks: ticks.length,
    actionableTicks: window.length,
    stallTicks,
    longestStall: longest,
    actions,
    reads,
    escalations,
    exchanges,
    exchangesCarried: carried,
  };

  const completion = checklistScore(checklist);
  const decisions = actions + escalations;
  const candidates: Array<AutonomyComponent & { applicable: boolean }> = [
    {
      id: "completion",
      label: "Got the job done",
      value: clamp01(completion),
      weight: BASE_WEIGHTS.completion,
      detail: `${checklist.filter((c) => c.passed).length}/${checklist.length} criteria passed, ${pct(completion)} by weight`,
      // Always applicable: an episode with no criteria scores 0 by core's rule, and
      // a spec that verified nothing should look broken rather than perfect.
      applicable: true,
    },
    {
      id: "independence",
      label: "Acted instead of asking",
      value: decisions === 0 ? 0 : clamp01(actions / decisions),
      weight: BASE_WEIGHTS.independence,
      detail:
        decisions === 0
          ? "the agent neither acted nor escalated"
          : `${actions} action(s) against ${escalations} escalation(s)`,
      applicable: decisions > 0,
    },
    {
      id: "momentum",
      label: "Kept working as the day moved",
      value: window.length === 0 ? 0 : clamp01(1 - stallTicks / window.length),
      weight: BASE_WEIGHTS.momentum,
      detail:
        window.length === 0
          ? "nothing ever arrived"
          : `${stallTicks}/${window.length} working tick(s) silent, longest stall ${longest} tick(s)`,
      applicable: window.length > 0,
    },
    {
      id: "follow-through",
      label: "Came back for the answers",
      value: exchanges === 0 ? 0 : clamp01(carried / exchanges),
      weight: BASE_WEIGHTS["follow-through"],
      detail:
        exchanges === 0
          ? "nobody answered the agent in time for it to respond"
          : `${carried}/${exchanges} reply(s) from the world were followed up`,
      applicable: exchanges > 0,
    },
  ];

  const applicable = candidates.filter((c) => c.applicable);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  const components: AutonomyComponent[] = applicable.map(({ applicable: _drop, ...c }) => ({
    ...c,
    weight: totalWeight === 0 ? 0 : c.weight / totalWeight,
  }));

  const score = components.reduce((sum, c) => sum + c.value * c.weight, 0);
  return { score: clamp01(score), components, stats };
}
