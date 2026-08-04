import type { EpisodeJudgeInput } from "@sonata/core";
import { describe, expect, it } from "vitest";
import { buildEpisodePrompt, EPISODE_JUDGE_SCHEMA } from "../src/prompt";

// The prompt is the judge's whole instrument. These tests guard the two properties
// that are easy to break by accident and expensive to notice: that it is pure, and
// that the sections stay in the order that makes it work.

function input(over: Partial<EpisodeJudgeInput> = {}): EpisodeJudgeInput {
  return {
    runId: "run-1",
    specId: "spec-1",
    task: "Run ops for the day. Answer clients yourself.",
    story: "Dana escalates at 09:15 while Sam is double-booked.",
    timeline: [
      {
        tick: 1,
        simTimeISO: "2026-08-04T09:15:00Z",
        source: "world",
        twin: "gmail",
        text: "Dana Reyes emailed about the missed SLA",
      },
      {
        tick: 2,
        simTimeISO: "2026-08-04T09:30:00Z",
        source: "agent",
        twin: "gmail",
        text: "WRITE send_reply → sent reply M9",
        seq: 4,
      },
      {
        tick: 3,
        simTimeISO: "2026-08-04T09:45:00Z",
        source: "director",
        twin: "gmail",
        text: "dana replied: that is not good enough",
        seq: 4,
      },
    ],
    diffs: {
      gmail: {
        twin: "gmail",
        added: [],
        removed: [],
        changed: [
          {
            threadId: "T1",
            subject: "SLA breach",
            labelsAdded: ["Client"],
            labelsRemoved: [],
            messagesAdded: 1,
          },
        ],
        draftsAdded: [{ draftId: "D1", subject: "Re: invoice", to: ["ap@x.test"], excerpt: "Hi…" }],
        unchangedCount: 12,
      },
    },
    trace: {
      steps: [
        {
          seq: 4,
          tick: 2,
          twin: "gmail",
          name: "send_reply",
          args: { threadId: "T1", body: "We are on it." },
          resultSummary: "sent reply M9",
          isMutation: true,
        },
      ],
      turns: [{ seq: 3, tick: 2, text: "Dana is waiting; I will answer her." }],
      escalations: [{ seq: 9, tick: 6, text: "Sam, can you confirm the credit?" }],
      agentSummary: "Answered Dana, flagged the credit.",
    },
    checklistResults: [
      {
        id: "c1",
        description: "the client got an answer",
        twin: "gmail",
        kind: "replied",
        severity: "must",
        weight: 2,
        passed: true,
        evidence: "replied: [audit 1] POST /send thread T1",
        tick: 2,
      },
    ],
    judgeQuestions: ["Was the tone right for a client this angry?"],
    ...over,
  };
}

describe("buildEpisodePrompt", () => {
  it("is pure — same input, same output, and the input is not mutated", () => {
    const a = input();
    const snapshot = JSON.stringify(a);
    const first = buildEpisodePrompt(a);
    const second = buildEpisodePrompt(a);

    expect(first).toEqual(second);
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it("puts the task and the restatement before any of the evidence", () => {
    const { prompt } = buildEpisodePrompt(input());
    const at = (needle: string) => {
      const i = prompt.indexOf(needle);
      expect(i, `section "${needle}" is missing`).toBeGreaterThanOrEqual(0);
      return i;
    };

    const order = [
      "THE TASK THE AGENT WAS GIVEN",
      "FIRST, RESTATE THE TASK",
      "THE DAY, AS IT HAPPENED",
      "WHAT THE AGENT DID",
      "WHAT THE AGENT SAID",
      "WHAT THE WORLD DID BACK",
      "WHAT CHANGED ON EACH SURFACE",
      "DETERMINISTIC CHECKS ALREADY RUN",
      "FAILURE MODES TO CHECK",
      "THE QUESTION",
    ].map(at);

    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("restates the task before it is told the deterministic score", () => {
    const { prompt } = buildEpisodePrompt(input());
    expect(prompt.indexOf("FIRST, RESTATE THE TASK")).toBeLessThan(
      prompt.indexOf("DETERMINISTIC CHECKS ALREADY RUN"),
    );
  });

  it("carries the task, the timeline, the reply body and the checklist evidence", () => {
    const { prompt } = buildEpisodePrompt(input());
    expect(prompt).toContain("Run ops for the day");
    expect(prompt).toContain("Dana Reyes emailed about the missed SLA");
    // Bodies are never truncated: tone is only judgeable from what was written.
    expect(prompt).toContain("We are on it.");
    expect(prompt).toContain("[audit 1] POST /send thread T1");
    expect(prompt).toContain("DRAFT (never sent)");
  });

  it("separates the world's reactions from the agent's own steps", () => {
    const { prompt } = buildEpisodePrompt(input());
    const reactions = prompt.slice(prompt.indexOf("WHAT THE WORLD DID BACK"));
    expect(reactions).toContain("dana replied: that is not good enough");
    expect(reactions).toContain("in answer to step [4]");

    const day = prompt.slice(prompt.indexOf("THE DAY, AS IT HAPPENED"), prompt.indexOf("WHAT THE AGENT DID"));
    expect(day).not.toContain("dana replied");
  });

  it("asks the episode's own questions, numbered and in order", () => {
    const { prompt } = buildEpisodePrompt(
      input({ judgeQuestions: ["Q one?", "Q two?"] }),
    );
    expect(prompt).toContain("1. Q one?");
    expect(prompt).toContain("2. Q two?");
  });

  it("drops the questions section entirely when the episode asks none", () => {
    const { prompt } = buildEpisodePrompt(input({ judgeQuestions: [] }));
    expect(prompt).not.toContain("QUESTIONS THIS EPISODE ASKS BY NAME");
  });

  it("says so plainly when the agent did nothing at all", () => {
    const { prompt } = buildEpisodePrompt(
      input({ trace: { steps: [], turns: [], escalations: [] } }),
    );
    expect(prompt).toContain("the agent made no tool calls at all");
    expect(prompt).toContain("the agent said nothing as it worked");
  });
});

/** Every object node the provider will validate, found wherever it is nested. */
function objectNodes(node: unknown, path: string, out: Array<{ path: string; node: Record<string, unknown> }>): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.type === "object") out.push({ path, node: rec });
  for (const [key, value] of Object.entries(rec)) {
    if (Array.isArray(value)) value.forEach((v, i) => objectNodes(v, `${path}.${key}[${i}]`, out));
    else objectNodes(value, `${path}.${key}`, out);
  }
}

describe("EPISODE_JUDGE_SCHEMA", () => {
  it("is strict at every depth, not just the root", () => {
    const nodes: Array<{ path: string; node: Record<string, unknown> }> = [];
    objectNodes(EPISODE_JUDGE_SCHEMA, "$", nodes);
    expect(nodes.length).toBeGreaterThan(3);

    for (const { path, node } of nodes) {
      expect(node.additionalProperties, `${path} allows extra properties`).toBe(false);
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
      const required = (node.required ?? []) as string[];
      // Strict json_schema rejects a schema whose `required` is not exactly its
      // property list — an optional field has to be modelled with a sentinel.
      expect([...required].sort(), `${path} required != properties`).toEqual(properties.sort());
    }
  });

  it("asks for the task restatement before the verdict, since order is generation order", () => {
    const keys = Object.keys(EPISODE_JUDGE_SCHEMA.properties as Record<string, unknown>);
    expect(keys[0]).toBe("taskUnderstanding");
    expect(keys.indexOf("taskUnderstanding")).toBeLessThan(keys.indexOf("summary"));
    expect(keys.indexOf("taskUnderstanding")).toBeLessThan(keys.indexOf("findings"));
  });

  it("constrains findings to catalog ids", () => {
    const properties = EPISODE_JUDGE_SCHEMA.properties as Record<string, { items?: unknown }>;
    const items = properties.findings.items as { properties: { mode: { enum: string[] } } };
    expect(items.properties.mode.enum).toContain("stalled");
    expect(items.properties.mode.enum).toContain("cross-surface-inconsistency");
  });
});
