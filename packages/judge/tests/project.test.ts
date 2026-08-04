import type { EpisodeRun } from "@sonata/core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTimeline, buildTrace, projectEpisode } from "../src/project";
import { directorEvent, gmailSnapshot, resetSeq, tickRecord, toolStep } from "./fixtures";

// Projection is the only path by which a run reaches the judge, so the thing worth
// testing is what it refuses to pass through: unbounded results, unbounded prose,
// and pasted email bodies masquerading as timeline rows.

function run(over: Partial<EpisodeRun> = {}): EpisodeRun {
  return {
    runId: "run-1",
    specId: "spec-1",
    specTitle: "Client escalates",
    model: "anthropic/claude-haiku-4.5",
    status: "done",
    startedAt: 1000,
    endedAt: 2000,
    ticks: [],
    snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
    verdict: null,
    ...over,
  };
}

describe("buildTrace", () => {
  beforeEach(resetSeq);

  it("bounds a runaway tool result to a signal, not a payload", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [toolStep({ resultSummary: "x".repeat(5000) })] }),
    ];
    const [step] = buildTrace(ticks).steps;
    expect(step.resultSummary.length).toBeLessThanOrEqual(300);
    expect(step.resultSummary.endsWith("…")).toBe(true);
  });

  it("keeps tool arguments verbatim — tone is only judgeable from what was written", () => {
    const body = "Dana, ".concat("we are genuinely sorry about this. ".repeat(40));
    const ticks = [tickRecord({ tick: 0, agentSteps: [toolStep({ args: { body } })] })];
    expect(buildTrace(ticks).steps[0].args).toEqual({ body });
  });

  it("bounds agent prose", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "y".repeat(9000) }],
      }),
    ];
    expect(buildTrace(ticks).turns[0].text.length).toBeLessThanOrEqual(2000);
  });

  it("splits steps, thoughts and escalations, tagging each with its tick", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 3,
        agentSteps: [
          { kind: "thought", seq: 1, at: 1, text: "Dana is waiting." },
          toolStep(),
          { kind: "escalation", seq: 3, at: 3, text: "Sam, can you confirm?" },
        ],
      }),
    ];
    const trace = buildTrace(ticks, "  I answered Dana.  ");
    expect(trace.steps).toHaveLength(1);
    expect(trace.turns[0]).toMatchObject({ tick: 3, text: "Dana is waiting." });
    expect(trace.escalations[0]).toMatchObject({ tick: 3, text: "Sam, can you confirm?" });
    expect(trace.agentSummary).toBe("I answered Dana.");
  });

  it("drops an empty thought rather than emitting a blank turn", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "   " }] }),
    ];
    expect(buildTrace(ticks).turns).toEqual([]);
  });

  it("omits agentSummary entirely when the agent gave none", () => {
    expect(buildTrace([tickRecord()], "   ").agentSummary).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  beforeEach(resetSeq);

  it("orders each tick as the engine runs it: world, then agent, then reaction", () => {
    const ticks = [
      tickRecord({
        tick: 2,
        beatsFired: [{ beatId: "b1", twin: "gmail", kind: "email", summary: "Dana emailed" }],
        agentSteps: [toolStep()],
        directorEvents: [directorEvent({ becauseSeq: 1 })],
      }),
    ];
    expect(buildTimeline(ticks).map((e) => e.source)).toEqual(["world", "agent", "director"]);
  });

  it("bounds a row so a pasted email cannot become the timeline", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b1", twin: "gmail", kind: "email", summary: "z".repeat(4000) }],
      }),
    ];
    expect(buildTimeline(ticks)[0].text.length).toBeLessThanOrEqual(240);
  });

  it("says on the row itself that a failed write changed nothing", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [toolStep({ error: "429 rate limited" })] }),
    ];
    expect(buildTimeline(ticks)[0].text).toContain("nothing changed");
  });

  it("keeps thoughts out of the record of what happened", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "hmm" }] }),
    ];
    expect(buildTimeline(ticks)).toEqual([]);
  });

  it("renders a director event on any surface without losing who or why", () => {
    const ticks = [
      tickRecord({ tick: 1, directorEvents: [directorEvent({ reason: "Dana pushes back" })] }),
    ];
    const [row] = buildTimeline(ticks);
    expect(row.source).toBe("director");
    expect(row.text).toContain("That is not good enough.");
    expect(row.text).toContain("[Dana pushes back]");
  });
});

describe("projectEpisode", () => {
  it("carries the task and story through, and folds deferred criteria into questions", () => {
    const input = projectEpisode({
      spec: {
        id: "spec-1",
        task: "Run ops today.",
        story: "Dana escalates.",
        success: { checklist: [], judgeQuestions: ["Was the tone right?"] },
      },
      run: run(),
      diffs: {},
      checklist: [],
      deferred: [
        {
          id: "c9",
          description: "the day held together across surfaces",
          twin: "any",
          kind: "judged",
          weight: 2,
          severity: "must",
        },
      ],
    });

    expect(input).toMatchObject({ runId: "run-1", specId: "spec-1", task: "Run ops today." });
    expect(input.judgeQuestions[0]).toBe("Was the tone right?");
    expect(input.judgeQuestions[1]).toContain("the day held together across surfaces");
    // Severity survives: a `must` the checklist could not decide is the one the judge
    // must not gloss over.
    expect(input.judgeQuestions[1]).toContain("must");
  });
});
