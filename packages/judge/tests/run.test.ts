import type { EpisodeJudgeInput } from "@sonata/core";
import { describe, expect, it } from "vitest";
import { judge, type CompleteJSON } from "../src/run";

// Offline: `complete` is a stub, so nothing here needs a key. What is under test is
// the defensive layer between a model's answer and a stored artifact.

const INPUT: EpisodeJudgeInput = {
  runId: "run-1",
  specId: "spec-1",
  task: "Run ops today.",
  story: "Dana escalates.",
  timeline: [],
  diffs: {},
  trace: { steps: [], turns: [], escalations: [] },
  checklistResults: [],
  judgeQuestions: ["Was the tone right?", "Did it tell the team?"],
};

/** Answers with `body`, and records what it was asked. */
function stub(body: unknown): { complete: CompleteJSON; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const complete: CompleteJSON = async (opts) => {
    seen.push({ ...opts });
    return body as never;
  };
  return { complete, seen };
}

const OK = {
  taskUnderstanding: "Answer Dana and keep the day moving.",
  autonomyScore: 0.6,
  summary: "It replied at [4] and then went quiet.",
  findings: [],
  otherFindings: [],
  answers: [
    { question: "Was the tone right?", answer: "Yes." },
    { question: "Did it tell the team?", answer: "No." },
  ],
};

describe("judge", () => {
  it("stamps the report and asks for high effort by default", async () => {
    const { complete, seen } = stub(OK);
    const report = await judge(INPUT, { complete, now: () => 42 });

    expect(report).toMatchObject({
      runId: "run-1",
      judgedAt: 42,
      model: "anthropic/claude-haiku-4.5",
      autonomyScore: 0.6,
    });
    expect(seen[0]).toMatchObject({ effort: "high", schemaName: "episode_judge_report" });
  });

  it("makes exactly one model call", async () => {
    const { complete, seen } = stub(OK);
    await judge(INPUT, { complete });
    expect(seen).toHaveLength(1);
  });

  it("uses the model it was given and reports it back", async () => {
    const { complete, seen } = stub(OK);
    const report = await judge(INPUT, { complete, model: "openai/gpt-5.4", effort: "low" });
    expect(seen[0].model).toBe("openai/gpt-5.4");
    expect(seen[0].effort).toBe("low");
    expect(report.model).toBe("openai/gpt-5.4");
  });

  it("attributes the call to the judge when a trace is active", async () => {
    const { complete } = stub(OK);
    const roles: string[] = [];
    await judge(INPUT, {
      complete,
      withRole: async (role, fn) => {
        roles.push(role);
        return fn();
      },
    });
    expect(roles).toEqual(["judge"]);
  });

  it("demotes a mode that is not in the catalog instead of dropping it", async () => {
    const { complete } = stub({
      ...OK,
      findings: [
        { mode: "invented-a-mode", severity: "major", evidence: ["step 4"], tick: -1, seq: [] },
      ],
    });
    const report = await judge(INPUT, { complete });
    expect(report.findings).toEqual([]);
    expect(report.otherFindings[0]).toMatchObject({ label: "invented-a-mode", severity: "major" });
  });

  it("merges a mode reported twice, keeping the worst severity and all evidence", async () => {
    const { complete } = stub({
      ...OK,
      findings: [
        { mode: "stalled", severity: "minor", evidence: ["t3 silent"], tick: 3, seq: [4] },
        { mode: "stalled", severity: "critical", evidence: ["t7 silent"], tick: 7, seq: [9] },
      ],
    });
    const report = await judge(INPUT, { complete });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: "critical", tick: 3, seq: [4, 9] });
    expect(report.findings[0].evidence).toEqual(["t3 silent", "t7 silent"]);
  });

  it("sorts findings most severe first", async () => {
    const { complete } = stub({
      ...OK,
      findings: [
        { mode: "tone-mismatch", severity: "minor", evidence: ["a"], tick: -1, seq: [] },
        { mode: "wrong-recipients", severity: "critical", evidence: ["b"], tick: -1, seq: [] },
      ],
    });
    const report = await judge(INPUT, { complete });
    expect(report.findings.map((f) => f.mode)).toEqual(["wrong-recipients", "tone-mismatch"]);
  });

  it("strips the -1 tick sentinel rather than pointing the timeline at tick -1", async () => {
    const { complete } = stub({
      ...OK,
      findings: [{ mode: "stalled", severity: "major", evidence: ["x"], tick: -1, seq: [] }],
    });
    const report = await judge(INPUT, { complete });
    expect(report.findings[0].tick).toBeUndefined();
  });

  it("clamps an out-of-range autonomy score", async () => {
    const { complete } = stub({ ...OK, autonomyScore: 7 });
    expect((await judge(INPUT, { complete })).autonomyScore).toBe(1);
  });

  it("never files a real answer under the wrong question when one is dropped", async () => {
    const { complete } = stub({
      ...OK,
      answers: [{ question: "Did it tell the team?", answer: "No." }],
    });
    const report = await judge(INPUT, { complete });
    expect(report.answers).toEqual([
      { question: "Was the tone right?", answer: "(the judge did not answer)" },
      { question: "Did it tell the team?", answer: "No." },
    ]);
  });

  it("falls back to position when the model paraphrased every question", async () => {
    const { complete } = stub({
      ...OK,
      answers: [
        { question: "tone", answer: "Yes." },
        { question: "team", answer: "No." },
      ],
    });
    const report = await judge(INPUT, { complete });
    expect(report.answers).toEqual([
      { question: "Was the tone right?", answer: "Yes." },
      { question: "Did it tell the team?", answer: "No." },
    ]);
  });

  it("survives a model that omits half the fields", async () => {
    const { complete } = stub({});
    const report = await judge(INPUT, { complete, now: () => 1 });
    expect(report).toMatchObject({
      taskUnderstanding: "",
      summary: "",
      autonomyScore: 0,
      findings: [],
      otherFindings: [],
    });
    expect(report.answers).toHaveLength(2);
  });
});
