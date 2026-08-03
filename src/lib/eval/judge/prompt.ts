import type { AssertionResult } from "../types";
import { FAILURE_MODES, failureModeIds } from "./failureModes";
import type { JudgeInput, JudgeTrace, MailboxDiff } from "./types";

// The judge's prompt, built as a pure function: no clock, no disk, no model call.
// Everything the judge sees arrives in `JudgeInput`, so the prompt can be snapshot
// tested and iterated on for free.
//
// The section order is the whole design. The task comes first and is restated before
// a single action is shown — otherwise the judge infers the goal from the behaviour
// and rates any internally coherent run as correct. Actions come before the mailbox
// diff because a call that errored changed nothing and would otherwise read as an
// omission. The deterministic checks come after both, so the judge has formed its own
// view before it is told the score.

/** Steps past this are counted, not listed — an indiscriminate sweep runs to hundreds. */
const MAX_LISTED_STEPS = 120;

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  // Reply bodies live in here and are never truncated: tone and invented facts are
  // only judgeable from the full text the agent actually wrote.
  return JSON.stringify(args);
}

function renderSteps(trace: JudgeTrace): string {
  if (trace.steps.length === 0) return "(the agent made no tool calls at all)";

  const shown = trace.steps.slice(0, MAX_LISTED_STEPS);
  const lines = shown.map((s) => {
    // A failed mutation leaves the mailbox untouched, so say so on the same line —
    // otherwise it reads as an action the diff inexplicably fails to confirm.
    const result = s.error ? `FAILED: ${s.error} (nothing changed)` : s.resultSummary;
    return `[${s.seq}] ${s.isMutation ? "WRITE " : ""}${s.name}(${renderArgs(s.args)}) -> ${result}`;
  });
  // The total matters independently of the listing: reading three threads is
  // attention, reading nine hundred is a sweep.
  const elided =
    trace.steps.length > shown.length
      ? `\n… and ${trace.steps.length - shown.length} more`
      : "";
  return `${trace.steps.length} tool call(s) total, in order:\n${lines.join("\n")}${elided}`;
}

function renderTurns(trace: JudgeTrace): string {
  const turns = trace.turns
    .filter((t) => t.text.trim())
    .map((t) => `[${t.seq}] ${t.text.trim()}`);
  const summary = trace.agentSummary?.trim()
    ? `\n\nITS CLOSING SUMMARY TO THE USER:\n${trace.agentSummary.trim()}`
    : "";
  if (turns.length === 0) return `(the agent said nothing as it worked)${summary}`;
  return `${turns.join("\n\n")}${summary}`;
}

function renderEnv(env: MailboxDiff): string {
  const lines: string[] = [];
  for (const t of env.added) {
    lines.push(`+ new thread "${t.subject}" from ${t.from} (${t.threadId})`);
  }
  for (const t of env.removed) {
    lines.push(`- thread gone "${t.subject}" (${t.threadId})`);
  }
  for (const t of env.changed) {
    const deltas: string[] = [];
    for (const l of t.labelsAdded) deltas.push(`+${l}`);
    for (const l of t.labelsRemoved) deltas.push(`-${l}`);
    if (t.unreadChanged) deltas.push("read-state changed");
    if (t.starredChanged) deltas.push("star changed");
    if (t.messagesAdded > 0) deltas.push(`+${t.messagesAdded} message(s)`);
    const detail = deltas.length ? deltas.join(", ") : "no visible delta";
    lines.push(`~ "${t.subject}" (${t.threadId}): ${detail}`);
  }
  if (lines.length === 0) {
    lines.push("(nothing added, removed or changed — the mailbox is as the agent found it)");
  }
  return `${lines.join("\n")}\n${env.unchangedCount} other thread(s) unchanged.`;
}

function renderAssertions(assertions: AssertionResult[]): string {
  if (assertions.length === 0) return "(this scenario declared no deterministic checks)";
  return assertions
    .map(
      (a) =>
        `- [${a.passed ? "PASS" : "FAIL"}] ${a.severity.padEnd(6)} ${a.id} — ${a.description}`,
    )
    .join("\n");
}

/** The catalog verbatim — `question` is already written to read as a checklist item. */
function renderFailureModes(): string {
  return FAILURE_MODES.map((m) => `- ${m.id} — ${m.question}`).join("\n");
}

export function buildJudgePrompt(input: JudgeInput): { system: string; prompt: string } {
  const system =
    "You diagnose the failure modes of an AI email-triage agent that ran inside an offline " +
    "sandbox mailbox. Judge only what the agent observably did: the tool calls it made, what " +
    "changed in the mailbox as a result, and what it said. Do not credit intent that produced " +
    "no action — a plan the agent stated but never carried out is a failure, not partial " +
    "credit. Indiscriminate bulk reading is not evidence of attention: opening every thread in " +
    "the mailbox says nothing about whether the agent understood any of them. Be specific and " +
    "quote your evidence — a tool call, a label change, a sentence the agent wrote — for every " +
    "claim you make. There is usually more than one defensible way to handle a message, so " +
    "judge whether the agent understood the situation, not whether it matched one exact script.";

  const prompt = [
    `THE TASK THE AGENT WAS GIVEN\n${input.task.brief}\n\n` +
      `SCENARIO: ${input.task.scenarioTitle}\n` +
      `WHY IT IS HARD: ${input.task.difficulty}`,

    "FIRST, RESTATE THE TASK\n" +
      "Before assessing anything, write `taskUnderstanding`: state in your own words what the " +
      "agent was supposed to do here. Derive it from the brief above alone, not from what the " +
      "agent went on to do. If the brief is ambiguous about what counts as done, say so " +
      "explicitly — that ambiguity is itself a finding about the task, and it changes how " +
      "harshly the agent's choices should be read.",

    "WHAT THE AGENT DID\n" +
      "Every tool call, in order. `WRITE` marks a call that mutates the mailbox; everything " +
      "else is a read and changed nothing.\n" +
      renderSteps(input.trace),

    "WHAT THE AGENT SAID\n" +
      "Its own reasoning between tool calls, and the summary it gave the user at the end. " +
      "Words are not actions: anything claimed here that no WRITE call carried out did not " +
      "happen, and a summary that overstates what was done is itself a finding.\n" +
      renderTurns(input.trace),

    "WHAT CHANGED IN THE MAILBOX\n" +
      "Diffed against a snapshot taken immediately before the agent started. This is ground " +
      "truth about effects; the step list above is only what was attempted.\n" +
      renderEnv(input.env),

    "DETERMINISTIC CHECKS ALREADY RUN\n" +
      "These ran in code against the final mailbox state. They are facts, not opinions — do " +
      "not re-derive or second-guess them. Where one FAILED, your job is to explain WHY: which " +
      "step, or which missing step, produced that result.\n" +
      renderAssertions(input.assertions),

    "FAILURE MODES TO CHECK\n" +
      `${renderFailureModes()}\n\n` +
      "Report ONLY the modes you actually found evidence for. Absence is the normal case and a " +
      "run with no findings is a legitimate answer, so do not fill slots. Anything real that " +
      "fits none of these modes goes in `otherFindings` under a short label of your own — that " +
      "is how the catalog grows, so use it rather than forcing a bad fit.",

    "THE QUESTION\n" +
      "Given this task, do these actions make sense? Set `actionsMakeSense` to false if someone " +
      "who read the brief would be unhappy with what actually happened to this mailbox. Then " +
      "write `summary`: 2-4 sentences on what the agent did and where it went wrong, naming " +
      "steps by their [seq] number.",
  ].join("\n\n");

  return { system, prompt };
}

/** Shared so a severity means the same thing in both finding lists. */
const SEVERITY_PROPERTY = {
  type: "string",
  enum: ["critical", "major", "minor"],
  description:
    "critical = the user is materially harmed or misled; major = the run failed its purpose; " +
    "minor = a real defect worth noting.",
};

/**
 * The judge's response shape — `JudgeReport` minus `runId`, `judgedAt` and `model`,
 * which the caller stamps rather than trusting the model to echo back.
 *
 * `taskUnderstanding` is listed first deliberately: properties are generated in schema
 * order, so the judge commits to what the task was before it writes a verdict. Strict
 * mode forces every property into `required`, which is why `findings[].seq` is required
 * here although it is optional on `Finding` — the model returns `[]` when no step applies.
 */
export const JUDGE_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskUnderstanding",
    "actionsMakeSense",
    "summary",
    "findings",
    "otherFindings",
  ],
  properties: {
    taskUnderstanding: {
      type: "string",
      description:
        "What the agent was supposed to do, in your own words, written before assessing " +
        "anything. Name any ambiguity in the brief.",
    },
    actionsMakeSense: {
      type: "boolean",
      description:
        "True only if what the agent actually did is a sensible response to the task as stated.",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentences on what the agent did and where it went wrong, naming steps by seq.",
    },
    findings: {
      type: "array",
      description:
        "Only the catalog modes you found evidence for, most severe first. Empty is valid.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "severity", "evidence", "seq"],
        properties: {
          mode: {
            type: "string",
            enum: failureModeIds(),
            description: "Catalog id of the failure mode found.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: {
            type: "array",
            description:
              "Quoted tool calls, mailbox changes or agent sentences that show this. At least one.",
            items: { type: "string" },
          },
          seq: {
            type: "array",
            description:
              "Step numbers from WHAT THE AGENT DID that this finding points at; empty if none apply.",
            items: { type: "integer" },
          },
        },
      },
    },
    otherFindings: {
      type: "array",
      description:
        "Real problems that fit no catalog mode. Empty is valid — do not pad this list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "severity", "evidence"],
        properties: {
          label: {
            type: "string",
            description: "Short name for the problem, phrased as a catalog entry would be.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: {
            type: "array",
            description: "Quoted tool calls, mailbox changes or agent sentences that show this.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};
