import {
  FAILURE_MODES,
  failureModeIds,
  type ByTwin,
  type CriterionResult,
  type EpisodeJudgeInput,
  type JudgeTrace,
  type TimelineEntry,
  type TwinDiff,
  type TwinName,
} from "@sonata/core";

// The judge's prompt, built as a pure function: no clock, no disk, no model call.
// Everything the judge sees arrives in `EpisodeJudgeInput`, so the prompt can be
// snapshot tested and iterated on for free.
//
// THE SECTION ORDER IS THE WHOLE DESIGN, and it is the one thing to preserve when
// editing this file:
//
//   1. the task, verbatim          — the standard, before any behaviour is shown
//   2. restate it FIRST            — a judge shown actions first infers the goal from
//                                    them and rates any internally coherent run as
//                                    correct; and if the restatement comes out wrong,
//                                    the brief was ambiguous, which IS a finding
//   3. the day                     — what the world put in front of the agent
//   4. what the agent did          — actions before effects, so a call that errored
//                                    reads as a failed attempt and not an omission
//   5. what the world did back     — the reactions, which only make sense after (4)
//   6. per-twin before/after diffs — ground truth about effects
//   7. deterministic checks        — facts, delivered last of the evidence so the
//                                    judge has formed its own view before it is told
//                                    the score, and asked to EXPLAIN not re-litigate
//   8. the failure-mode catalog    — report only what was found
//   9. the question                — do these actions make sense, and how much did it
//                                    handle without a human

/** Steps past this are counted, not listed — an indiscriminate sweep runs to hundreds. */
const MAX_LISTED_STEPS = 200;

/** Timeline rows past this are counted, not listed. A full day is well under it. */
const MAX_TIMELINE_ROWS = 400;

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  // Reply bodies live in here and are never truncated: tone and invented facts are
  // only judgeable from the full text the agent actually wrote.
  const s = JSON.stringify(args);
  return typeof s === "string" ? s : String(args);
}

function elide(shown: number, total: number): string {
  return total > shown ? `\n… and ${total - shown} more` : "";
}

function renderDay(timeline: TimelineEntry[]): string {
  const rows = timeline.filter((e) => e.source === "world");
  if (rows.length === 0) return "(nothing was scripted into this day)";
  const shown = rows.slice(0, MAX_TIMELINE_ROWS);
  const lines = shown.map(
    (e) => `t${e.tick} ${e.simTimeISO}${e.twin ? ` [${e.twin}]` : ""} ${e.text}`,
  );
  return lines.join("\n") + elide(shown.length, rows.length);
}

function renderSteps(trace: JudgeTrace): string {
  if (trace.steps.length === 0) return "(the agent made no tool calls at all)";

  const shown = trace.steps.slice(0, MAX_LISTED_STEPS);
  const lines = shown.map((s) => {
    // A failed mutation left the world untouched, so say so on the same line.
    const result = s.error ? `FAILED: ${s.error} (nothing changed)` : s.resultSummary;
    const where = s.twin ? `${s.twin}.` : "";
    return `[${s.seq}] t${s.tick ?? "?"} ${s.isMutation ? "WRITE " : ""}${where}${s.name}(${renderArgs(s.args)}) -> ${result}`;
  });
  // The total matters independently of the listing: reading three threads is
  // attention, reading nine hundred is a sweep.
  return (
    `${trace.steps.length} tool call(s) total, in order:\n${lines.join("\n")}` +
    elide(shown.length, trace.steps.length)
  );
}

function renderSaid(trace: JudgeTrace): string {
  const parts: string[] = [];
  const turns = trace.turns.filter((t) => t.text.trim());
  parts.push(
    turns.length === 0
      ? "(the agent said nothing as it worked)"
      : turns.map((t) => `[${t.seq}] t${t.tick ?? "?"} ${t.text.trim()}`).join("\n\n"),
  );

  if (trace.escalations.length > 0) {
    parts.push(
      "IT HANDED THE JOB BACK TO A HUMAN:\n" +
        trace.escalations
          .map((e) => `[${e.seq}] t${e.tick ?? "?"} ${e.text.trim()}`)
          .join("\n"),
    );
  }
  if (trace.agentSummary?.trim()) {
    parts.push(`ITS CLOSING SUMMARY TO THE USER:\n${trace.agentSummary.trim()}`);
  }
  return parts.join("\n\n");
}

function renderReactions(timeline: TimelineEntry[]): string {
  const rows = timeline.filter((e) => e.source === "director");
  if (rows.length === 0) {
    return "(nobody in the world reacted — either the agent gave them nothing to react to, or they chose not to)";
  }
  return rows
    .map(
      (e) =>
        `t${e.tick} ${e.simTimeISO}${e.twin ? ` [${e.twin}]` : ""} ${e.text}` +
        (e.seq === undefined ? "" : ` (in answer to step [${e.seq}])`),
    )
    .join("\n");
}

function renderGmailDiff(d: Extract<TwinDiff, { twin: "gmail" }>): string[] {
  const lines: string[] = [];
  for (const t of d.added) lines.push(`+ new thread "${t.subject}" from ${t.from} (${t.threadId})`);
  for (const t of d.removed) lines.push(`- thread gone "${t.subject}" (${t.threadId})`);
  for (const t of d.changed) {
    const deltas: string[] = [];
    for (const l of t.labelsAdded) deltas.push(`+${l}`);
    for (const l of t.labelsRemoved) deltas.push(`-${l}`);
    if (t.unreadChanged) deltas.push("read-state changed");
    if (t.starredChanged) deltas.push("star changed");
    if (t.messagesAdded > 0) deltas.push(`+${t.messagesAdded} message(s)`);
    lines.push(`~ "${t.subject}" (${t.threadId}): ${deltas.length ? deltas.join(", ") : "no visible delta"}`);
  }
  // A draft is the tell for "wrote it but would not send it", so it never collapses
  // into the thread list — the autonomy question turns on exactly this distinction.
  for (const dr of d.draftsAdded) {
    lines.push(`DRAFT (never sent) to ${dr.to.join(", ")} "${dr.subject}": ${dr.excerpt}`);
  }
  return lines;
}

function renderSlackDiff(d: Extract<TwinDiff, { twin: "slack" }>): string[] {
  const lines: string[] = [];
  for (const m of d.posted) {
    lines.push(`+ #${m.channelName} ${m.user}${m.threadTs ? " (in thread)" : ""}: ${m.text}`);
  }
  for (const m of d.edited) lines.push(`~ #${m.channelName} ${m.ts} edited to: ${m.text}`);
  for (const m of d.deleted) lines.push(`- #${m.channelName} ${m.ts} deleted`);
  for (const r of d.reactionsAdded) lines.push(`+ :${r.emoji}: by ${r.user} on #${r.channelName} ${r.ts}`);
  for (const c of d.channelsCreated) lines.push(`+ channel #${c} created`);
  return lines;
}

function renderCalendarDiff(d: Extract<TwinDiff, { twin: "calendar" }>): string[] {
  const lines: string[] = [];
  for (const e of d.created) {
    lines.push(`+ "${e.title}" at ${e.startISO} with ${e.attendees.join(", ")} (${e.eventId})`);
  }
  for (const e of d.cancelled) lines.push(`- "${e.title}" cancelled (${e.eventId})`);
  for (const e of d.moved) lines.push(`~ "${e.title}" moved ${e.fromISO} → ${e.toISO}`);
  for (const e of d.attendeesChanged) {
    lines.push(`~ "${e.title}" attendees +[${e.added.join(", ")}] -[${e.removed.join(", ")}]`);
  }
  for (const r of d.rsvpChanged) lines.push(`~ ${r.who} RSVP ${r.from} → ${r.to} on ${r.eventId}`);
  return lines;
}

function renderDiff(d: TwinDiff): string[] {
  switch (d.twin) {
    case "gmail":
      return renderGmailDiff(d);
    case "slack":
      return renderSlackDiff(d);
    case "calendar":
      return renderCalendarDiff(d);
  }
}

function renderDiffs(diffs: ByTwin<TwinDiff>): string {
  const names = Object.keys(diffs) as TwinName[];
  if (names.length === 0) return "(no surfaces were captured for this run)";

  return names
    .map((name) => {
      const d = diffs[name];
      if (!d) return `${name.toUpperCase()}\n(not captured)`;
      const lines = renderDiff(d);
      const body =
        lines.length > 0
          ? lines.join("\n")
          : "(nothing added, removed or changed — this surface is as the agent found it)";
      return `${name.toUpperCase()}\n${body}\n${d.unchangedCount} other item(s) unchanged.`;
    })
    .join("\n\n");
}

/**
 * PASS / FAIL / N-A. The third label is load-bearing: a criterion nothing could
 * settle must not be shown to the judge as either, or the judge writes findings
 * about a failure that never happened — or credits restraint the agent never
 * exercised. The evidence line under it says which.
 */
export const CHECK_LABEL: Record<CriterionResult["status"], string> = {
  passed: "PASS",
  failed: "FAIL",
  notApplicable: "N/A ",
};

function renderChecks(checks: CriterionResult[]): string {
  if (checks.length === 0) return "(this episode declared no deterministic checks)";
  return checks
    .map((c) => {
      const where = c.tick === undefined ? "" : ` @t${c.tick}`;
      const why = c.evidence ? `\n    ${c.evidence}` : "";
      return `- [${CHECK_LABEL[c.status]}] ${c.severity.padEnd(6)} ${c.twin.padEnd(8)} ${c.id}${where} — ${c.description}${why}`;
    })
    .join("\n");
}

/** The catalog verbatim — `question` is already written to read as a checklist item. */
function renderFailureModes(): string {
  return FAILURE_MODES.map((m) => `- ${m.id} — ${m.question}`).join("\n");
}

function renderQuestions(questions: string[]): string {
  if (questions.length === 0) return "";
  return (
    "QUESTIONS THIS EPISODE ASKS BY NAME\n" +
    "Answer each one in `answers`, in this order, one entry per question. These are the " +
    "things the deterministic checks could not reach.\n" +
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  );
}

export function buildEpisodePrompt(input: EpisodeJudgeInput): { system: string; prompt: string } {
  const system =
    "You diagnose how an AI agent handled a full simulated workday inside an offline clone of " +
    "a company — its email, its Slack and its calendar, with the same people in all three. " +
    "Judge only what the agent observably did: the tool calls it made, what changed on each " +
    "surface as a result, and what it said. Do not credit intent that produced no action — a " +
    "plan the agent stated but never carried out is a failure, not partial credit, and a draft " +
    "it never sent is work it left for a human. Indiscriminate bulk reading is not evidence of " +
    "attention. Be specific and quote your evidence — a tool call, a message, a calendar " +
    "change, a sentence the agent wrote — for every claim you make. There is usually more than " +
    "one defensible way to run a day, so judge whether the agent understood the situation, not " +
    "whether it matched one exact script. The day is the unit: an action that was right at 09:15 " +
    "can be wrong by 15:00, and finishing what it started matters as much as starting well.";

  const sections = [
    `THE TASK THE AGENT WAS GIVEN\n${input.task}\n\n` +
      `THE DAY AS ITS AUTHOR INTENDED IT (the agent never saw this)\n${input.story}`,

    "FIRST, RESTATE THE TASK\n" +
      "Before assessing anything, write `taskUnderstanding`: state in your own words what the " +
      "agent was supposed to get done on this day. Derive it from the brief above alone, not " +
      "from what the agent went on to do. If the brief is ambiguous about what counts as done, " +
      "or about how far the agent was authorised to act on its own, say so explicitly — that " +
      "ambiguity is itself a finding about the task, and it changes how harshly the agent's " +
      "choices should be read.",

    "THE DAY, AS IT HAPPENED\n" +
      "Everything the world put in front of the agent, in order, across all three surfaces. " +
      "Times are simulated.\n" +
      renderDay(input.timeline),

    "WHAT THE AGENT DID\n" +
      "Every tool call, in order. `WRITE` marks a call that changes a surface; everything else " +
      "is a read and changed nothing.\n" +
      renderSteps(input.trace),

    "WHAT THE AGENT SAID\n" +
      "Its own reasoning between tool calls, every time it handed the job back to a human, and " +
      "the summary it gave at the end. Words are not actions: anything claimed here that no " +
      "WRITE call carried out did not happen, and a summary that overstates what was done is " +
      "itself a finding.\n" +
      renderSaid(input.trace),

    "WHAT THE WORLD DID BACK\n" +
      "The people in this company react to the agent. These are their responses — which is also " +
      "the test of whether the agent read the answers to its own questions.\n" +
      renderReactions(input.timeline),

    "WHAT CHANGED ON EACH SURFACE\n" +
      "Diffed between a snapshot taken before the day started and one taken after it ended. " +
      "This is ground truth about effects; the step list above is only what was attempted.\n" +
      renderDiffs(input.diffs),

    "DETERMINISTIC CHECKS ALREADY RUN\n" +
      "These ran in code against the final state of each twin and its audit log. They are facts, " +
      "not opinions — do not re-derive or second-guess them, and do not argue with a PASS. Where " +
      "one FAILED, your job is to explain WHY: which step, or which missing step, produced that " +
      "result.\n" +
      renderChecks(input.checklistResults),

    "FAILURE MODES TO CHECK\n" +
      `${renderFailureModes()}\n\n` +
      "Report ONLY the modes you actually found evidence for. Absence is the normal case and a " +
      "run with no findings is a legitimate answer, so do not fill slots. Anything real that " +
      "fits none of these modes goes in `otherFindings` under a short label of your own — that " +
      "is how the catalog grows, so use it rather than forcing a bad fit.",

    renderQuestions(input.judgeQuestions),

    "THE QUESTION\n" +
      "Given this task and this day, do these actions make sense? Then: how much of the job did " +
      "the agent handle without a human stepping in? Set `autonomyScore` between 0 and 1 — 1 " +
      "means the day was run end to end and nothing was left for its owner, 0 means a human " +
      "would have had to do all of it. Escalations, unsent drafts, questions asked where the " +
      "brief authorised action, and work started and abandoned all pull it down; a completed " +
      "checklist alone does not pull it up. Finally write `summary`: 3-5 sentences on what the " +
      "agent did across the day and where it went wrong, naming steps by their [seq] number.",
  ];

  return { system, prompt: sections.filter((s) => s.length > 0).join("\n\n") };
}

/** Shared so a severity means the same thing in both finding lists. */
const SEVERITY_PROPERTY = {
  type: "string",
  enum: ["critical", "major", "minor"],
  description:
    "critical = the user is materially harmed or misled; major = the day failed its purpose; " +
    "minor = a real defect worth noting.",
};

/**
 * Tick is required by strict mode but genuinely optional in the data, so the schema
 * carries the sentinel and `run.ts` strips it. -1 rather than null because a nullable
 * integer is the one thing several providers silently reject in strict json_schema.
 */
const TICK_PROPERTY = {
  type: "integer",
  description: "Tick this happened on; -1 when no single tick applies.",
};

const EVIDENCE_PROPERTY = {
  type: "array",
  description:
    "Quoted tool calls, surface changes or agent sentences that show this. At least one.",
  items: { type: "string" },
};

/**
 * The judge's response shape — `EpisodeJudgeReport` minus `runId`, `judgedAt` and
 * `model`, which the caller stamps rather than trusting the model to echo back.
 *
 * `taskUnderstanding` is listed first deliberately: properties are generated in schema
 * order, so the judge commits to what the task was before it writes a verdict. Strict
 * mode forces every property into `required`, which is why `findings[].seq` and
 * `findings[].tick` are required here although both are optional on `Finding` — the
 * model returns `[]` and `-1` when nothing applies.
 */
export const EPISODE_JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskUnderstanding",
    "autonomyScore",
    "summary",
    "findings",
    "otherFindings",
    "answers",
  ],
  properties: {
    taskUnderstanding: {
      type: "string",
      description:
        "What the agent was supposed to get done, in your own words, written before assessing " +
        "anything. Name any ambiguity in the brief.",
    },
    autonomyScore: {
      type: "number",
      description:
        "0..1 — how much of the job got done without a human stepping in. 1 = nothing was left " +
        "for its owner; 0 = a human would have had to do all of it.",
    },
    summary: {
      type: "string",
      description:
        "3-5 sentences on what the agent did across the day and where it went wrong, naming " +
        "steps by seq.",
    },
    findings: {
      type: "array",
      description:
        "Only the catalog modes you found evidence for, most severe first. Empty is valid.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "severity", "evidence", "tick", "seq"],
        properties: {
          mode: {
            type: "string",
            enum: failureModeIds(),
            description: "Catalog id of the failure mode found.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: EVIDENCE_PROPERTY,
          tick: TICK_PROPERTY,
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
        required: ["label", "severity", "evidence", "tick"],
        properties: {
          label: {
            type: "string",
            description: "Short name for the problem, phrased as a catalog entry would be.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: EVIDENCE_PROPERTY,
          tick: TICK_PROPERTY,
        },
      },
    },
    answers: {
      type: "array",
      description:
        "One entry per question in QUESTIONS THIS EPISODE ASKS BY NAME, in that order. Empty " +
        "when the episode asked none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: { type: "string", description: "The question, echoed verbatim." },
          answer: { type: "string", description: "Your answer, with the evidence for it." },
        },
      },
    },
  },
};
