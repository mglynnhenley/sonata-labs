import {
  agentToolCalls,
  scoreChecklist,
  verdictOutcome,
  type TickRecord,
  type WorldAssessment,
} from "@sonata/core";
import { describe, expect, it } from "vitest";
import { autonomy } from "../src/autonomy";
import {
  escalationsFromTicks,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "../src/checklist";
import { projectEpisode } from "../src/project";
import { buildEpisodePrompt } from "../src/prompt";
import { auditRow, criterion, gmailSnapshot, tickRecord, toolStep, WORLD } from "./fixtures";

// A CHARACTER'S OPINION MAY NEVER MOVE THE SCORE.
//
// The people in this world are cheap models playing characters written to want
// something and to be unhappy until they get it. If one of them could grade the
// agent, the benchmark would be measuring the world — and the failure would be
// invisible, because a run scored by a disappointed client still produces a number
// that looks like every other number.
//
// So the constraint is asserted directly rather than reasoned about: the SAME run,
// once with the world's opinions recorded on it and once without, must produce the
// identical checklist, the identical score, the identical verdict and the identical
// autonomy figure. `WorldAssessment` carries no weight and no severity so that this
// is true by shape, and these tests are what would notice if that ever stopped
// being enough.

const SATISFIED: WorldAssessment = { personId: "dana", satisfied: "yes" };
const FURIOUS: WorldAssessment = {
  personId: "dana",
  satisfied: "no",
  missing: "everything — nobody has answered me all day",
};

/**
 * One ordinary day: the client writes, the agent replies, the client comes back,
 * and the agent hands one thing to a human.
 *
 * `view` is the only thing that varies. Pass nothing for a run from before any of
 * this existed; pass an opinion to put it on both the reworded beat and the
 * reaction, which are the two ways a person can speak.
 */
function day(view?: WorldAssessment): TickRecord[] {
  const assessed = view ? { assessment: view } : {};
  return [
    tickRecord({
      tick: 0,
      beatsFired: [
        {
          beatId: "b1",
          ref: "escalation",
          twin: "gmail",
          kind: "email",
          handle: { twin: "gmail", id: "M1", containerId: "T1" },
          summary: "Dana Reyes emailed about the missed SLA",
          ...assessed,
        },
      ],
    }),
    tickRecord({
      tick: 1,
      agentSteps: [
        { kind: "thought", seq: 1, at: 1001, text: "answering Dana" },
        toolStep({ seq: 2, at: 1002 }),
        { kind: "escalation", seq: 3, at: 1003, text: "Sam, can you approve the credit?" },
      ],
    }),
    tickRecord({
      tick: 2,
      directorEvents: [
        {
          id: "d1",
          twin: "gmail",
          kind: "email",
          payload: { from: "dana", to: ["sam"], subject: "Re: SLA", body: "Still waiting." },
          personId: "dana",
          reason: "Dana pushes back",
          becauseSeq: 2,
          ...assessed,
        },
      ],
    }),
  ];
}

/** The deterministic half of a verdict, derived from the ticks exactly as a run is. */
function verdict(ticks: TickRecord[]) {
  const { results } = runChecklist({
    criteria: [
      criterion({ id: "replied", kind: "replied", ref: "escalation", severity: "must", weight: 3 }),
      criterion({
        id: "kept-it",
        description: "never handed the job back",
        kind: "no-escalation",
        severity: "should",
        weight: 1,
      }),
    ],
    world: WORLD,
    refs: refsFromTicks(ticks),
    snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
    audit: [auditRow({ id: 1, actionType: "send_reply", targetId: "T1", ts: 1002 })],
    escalations: escalationsFromTicks(ticks),
    written: writtenFromTicks(ticks),
    agentActed: agentToolCalls(ticks) > 0,
    tickOf: tickIndexer(ticks),
  });
  return {
    checklist: results,
    score: scoreChecklist(results),
    outcome: verdictOutcome(results),
    autonomy: autonomy(results, ticks),
  };
}

describe("a character's opinion and the score", () => {
  it("changes no checklist result, no score, no verdict and no autonomy figure", () => {
    // The furious one, because that is the direction that would flatter a bad run
    // into a worse one — and the satisfied one, because the reverse is just as bad.
    const bare = verdict(day());
    // The run has to have decided something, or this asserts that two empty
    // checklists are equal — which they would be with the whole feature deleted.
    expect(bare.checklist.map((c) => c.status)).toEqual(["passed", "failed"]);
    expect(bare.autonomy.score).toBeGreaterThan(0);

    for (const view of [FURIOUS, SATISFIED]) {
      expect(verdict(day(view))).toEqual(bare);
    }

    // And the comparison above is live rather than vacuous: something the agent
    // really did move all four numbers, on the same fixture, through the same call.
    const quieter = day().map((t) =>
      t.tick === 1 ? { ...t, agentSteps: t.agentSteps.filter((s) => s.kind !== "escalation") } : t,
    );
    expect(verdict(quieter)).not.toEqual(bare);
  });

  it("reaches the judge, and changes nothing else in what the judge is shown", () => {
    // It is evidence, so it must arrive; it is only evidence, so nothing else about
    // the run may move because it did.
    const withView = projectEpisode({
      spec: { id: "spec-1", task: "Run the day.", story: "Dana escalates.", success: { checklist: [], judgeQuestions: [] } },
      run: run(day(FURIOUS)),
      diffs: {},
      checklist: [],
    });
    const bare = projectEpisode({
      spec: { id: "spec-1", task: "Run the day.", story: "Dana escalates.", success: { checklist: [], judgeQuestions: [] } },
      run: run(day()),
      diffs: {},
      checklist: [],
    });

    expect(withView.timeline.filter((e) => e.assessment).map((e) => e.assessment)).toEqual([
      FURIOUS,
      FURIOUS,
    ]);
    expect(bare.timeline.some((e) => e.assessment)).toBe(false);
    // Same rows, same order, same text — the opinion rides alongside and replaces
    // nothing a person actually said.
    expect(withView.timeline.map(({ assessment, ...row }) => row)).toEqual(bare.timeline);
    expect({ ...withView, timeline: [] }).toEqual({ ...bare, timeline: [] });
  });

  it("never puts a character's words where the deterministic checks are", () => {
    // The one place in the prompt the judge is told not to argue with. An opinion
    // that landed in it would be an opinion the judge is instructed to treat as a
    // fact, which is the whole failure by another route.
    const projected = projectEpisode({
      spec: { id: "spec-1", task: "Run the day.", story: "Dana escalates.", success: { checklist: [], judgeQuestions: [] } },
      run: run(day(FURIOUS)),
      diffs: {},
      checklist: verdict(day(FURIOUS)).checklist,
    });
    const { prompt } = buildEpisodePrompt(projected);
    const checks = prompt.slice(prompt.indexOf("DETERMINISTIC CHECKS ALREADY RUN"));
    expect(checks).not.toContain("nobody has answered me all day");
    expect(checks).not.toContain("satisfied:");
  });
});

/** The artifact around a set of ticks — only the ticks matter to any of this. */
function run(ticks: TickRecord[]) {
  return {
    runId: "run-1",
    specId: "spec-1",
    specTitle: "Client escalates",
    model: "anthropic/claude-haiku-4.5",
    status: "done" as const,
    startedAt: 1000,
    endedAt: 2000,
    ticks,
    snapshots: {},
    verdict: null,
  };
}
