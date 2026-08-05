import { runTruncation, type RunTruncation } from "@sonata/core";
import type {
  AgentStep,
  BeatBody,
  ByTwin,
  Criterion,
  CriterionResult,
  DirectorEvent,
  EpisodeJudgeInput,
  EpisodeRun,
  EpisodeSpec,
  JudgeStep,
  JudgeTrace,
  TickRecord,
  TimelineEntry,
  TwinDiff,
} from "@sonata/core";

// Compress a finished run into the object the judge reads.
//
// THIS IS THE ONLY PATH BY WHICH A RUN REACHES THE JUDGE. Nothing downstream may
// read an `EpisodeRun` directly, and the reason is size: a day is ~32 ticks across
// three twins, and the run artifact carries every tool result verbatim — a single
// `list_messages` result can be a hundred kilobytes, and the trace behind it re-serializes
// the whole conversation on every turn. Handing that to a model blows its context
// long before it reads a finding, and `completeJSON` caps output tokens, not input.
//
// What survives: one line per thing that happened (the timeline), what the agent did
// with results summarized to a line, what it said, and the per-twin diffs — which are
// ground truth about effects and cost almost nothing, because a diff lists what
// changed and counts what did not.

/** Cap on a projected tool result. Past this a result is a payload, not a signal. */
const MAX_SUMMARY = 300;

/** Cap on one turn of agent prose — a few paragraphs of reasoning, no more. */
const MAX_TURN = 2000;

/** Cap on a timeline row. These are already one-liners; this catches a pasted email. */
const MAX_LINE = 240;

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** One line for anything a beat or the director injected, whatever surface it hit. */
function describeBody(body: BeatBody): string {
  switch (body.twin) {
    case "gmail":
      return `${body.payload.from} emailed "${body.payload.subject}": ${body.payload.body}`;
    case "slack":
      return body.kind === "message"
        ? `${body.payload.from} in #${body.payload.channel}: ${body.payload.text}`
        : `${body.payload.from} reacted :${body.payload.emoji}:`;
    case "calendar":
      switch (body.kind) {
        case "invite":
          return `${body.payload.organizer} invited ${body.payload.attendees.join(", ")} to "${body.payload.title}" at ${body.payload.startISO}`;
        case "move":
          return `event moved to ${body.payload.startISO}${body.payload.reason ? ` — ${body.payload.reason}` : ""}`;
        case "cancel":
          return `event cancelled${body.payload.reason ? ` — ${body.payload.reason}` : ""}`;
        case "rsvp":
          return `${body.payload.who} ${body.payload.response}${body.payload.comment ? ` — ${body.payload.comment}` : ""}`;
      }
  }
}

function directorLine(e: DirectorEvent): string {
  const why = e.reason.trim() ? ` [${e.reason.trim()}]` : "";
  const failed = e.error ? ` (FAILED: ${e.error})` : "";
  return `${describeBody(e)}${why}${failed}`;
}

function agentLine(s: AgentStep): string {
  switch (s.kind) {
    case "thought":
      return s.text;
    case "escalation":
      return `ESCALATED to a human: ${s.text}`;
    case "tool":
      // A failed mutation changed nothing, so say so on the same line — otherwise it
      // reads as an action the diff inexplicably fails to confirm.
      return `${s.isMutation ? "WRITE " : ""}${s.name} → ${s.error ? `FAILED: ${s.error} (nothing changed)` : s.resultSummary}`;
  }
}

/**
 * Every event of the day in order, flattened across sources. Beats fire first, then
 * the agent works, then the world reacts — the same order the engine runs a tick in,
 * so a reader can follow cause and effect down the page.
 *
 * Thoughts are excluded: they are the agent talking to itself and belong in the
 * trace, not in the record of what happened.
 */
export function buildTimeline(ticks: TickRecord[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const t of ticks) {
    for (const b of t.beatsFired) {
      out.push({
        tick: t.tick,
        simTimeISO: t.simTimeISO,
        source: "world",
        twin: b.twin,
        text: truncate(b.error ? `${b.summary} (FAILED: ${b.error})` : b.summary, MAX_LINE),
      });
    }
    for (const s of t.agentSteps) {
      if (s.kind === "thought") continue;
      out.push({
        tick: t.tick,
        simTimeISO: t.simTimeISO,
        source: "agent",
        twin: s.kind === "tool" ? s.twin : null,
        text: truncate(agentLine(s), MAX_LINE),
        seq: s.seq,
      });
    }
    for (const e of t.directorEvents) {
      out.push({
        tick: t.tick,
        simTimeISO: t.simTimeISO,
        source: "director",
        twin: e.twin,
        text: truncate(directorLine(e), MAX_LINE),
        ...(e.becauseSeq === undefined ? {} : { seq: e.becauseSeq }),
      });
    }
    for (const n of t.notes) {
      out.push({
        tick: t.tick,
        simTimeISO: t.simTimeISO,
        source: "world",
        twin: null,
        text: truncate(`(engine) ${n}`, MAX_LINE),
      });
    }
  }
  return out;
}

/**
 * The agent's own record. Tool arguments survive verbatim and untruncated: tone and
 * invented facts are only judgeable from the full text the agent actually wrote, and
 * that text lives in the arguments, never in the result.
 */
export function buildTrace(ticks: TickRecord[], agentSummary?: string): JudgeTrace {
  const steps: JudgeStep[] = [];
  const turns: JudgeTrace["turns"] = [];
  const escalations: JudgeTrace["escalations"] = [];

  for (const t of ticks) {
    for (const s of t.agentSteps) {
      if (s.kind === "tool") {
        steps.push({
          seq: s.seq,
          tick: t.tick,
          twin: s.twin,
          name: s.name,
          args: s.args,
          resultSummary: truncate(s.resultSummary, MAX_SUMMARY),
          isMutation: s.isMutation,
          ...(s.error ? { error: s.error } : {}),
        });
      } else if (s.kind === "thought") {
        const text = truncate(s.text, MAX_TURN);
        if (text) turns.push({ seq: s.seq, tick: t.tick, text });
      } else {
        escalations.push({ seq: s.seq, tick: t.tick, text: truncate(s.text, MAX_TURN) });
      }
    }
  }

  return {
    steps,
    turns,
    escalations,
    ...(agentSummary?.trim() ? { agentSummary: truncate(agentSummary, MAX_TURN) } : {}),
  };
}

export interface ProjectInput {
  /**
   * The four fields the judge reads, plus the two that say how much of the day it
   * is reading. A whole `EpisodeSpec` fits and is now partly used: the clock and the
   * beats are what turn "the agent ignored this customer" into "the customer never
   * wrote", and without them the judge is shown a story longer than the day.
   */
  spec: Pick<EpisodeSpec, "id" | "task" | "story" | "success"> &
    Partial<Pick<EpisodeSpec, "clock" | "beats" | "termination">>;
  run: EpisodeRun;
  /** Per-twin, from each adapter's pure `diff`. Only twins the run used. */
  diffs: ByTwin<TwinDiff>;
  /** What `runChecklist` concluded. Facts by the time they get here. */
  checklist: CriterionResult[];
  /** `judged` criteria the checklist could not decide — asked as questions instead. */
  deferred?: Criterion[];
  /** The agent's closing account of its day, which `EpisodeRun` does not carry. */
  agentSummary?: string;
  /** Computed from `spec` when it carries a clock and beats; pass one to override. */
  truncation?: RunTruncation;
}

/**
 * What the judge must be told about a day we cut short, appended to the story.
 *
 * The story is the one thing the judge is handed as prose about what the day was
 * MEANT to be — "THE DAY AS ITS AUTHOR INTENDED IT" — and on a truncated run the
 * gap between that and the day the agent got is the single most misleading thing in
 * the prompt. Everything else the judge sees (the timeline, the steps, the diffs) is
 * a record of what happened, and a moment that never happened leaves no trace in any
 * of them: the absence is invisible, so the judge reads the story, sees no reply to
 * its third act, and files a finding.
 *
 * On `run_msg6yuxd_6tsw` the judge got most of the way there by itself — it wrote
 * "no scripted arrival shown" in its own evidence — and returned a critical anyway.
 * It had the observation and no permission to act on it. So the permission is
 * explicit here, in the imperative, next to the list of exactly which moments it
 * applies to. A judge that is merely shown a fact will still reach for the finding.
 */
function truncationBriefing(t: RunTruncation): string {
  const shown = t.unfired.map((b) => `  - ${b.summary}`).join("\n");
  return [
    "HOW MUCH OF THIS DAY THE AGENT ACTUALLY GOT",
    `The story above is the whole day. This run is not the whole day: ${t.executedTicks} of its ` +
      `${t.scheduledTicks} ticks ran before the harness stopped it.`,
    t.unfired.length === 0
      ? "Every scripted moment that did exist reached the agent, but nothing the story places from " +
        `tick ${t.executedTicks} onwards ever happened.`
      : "These scripted moments NEVER HAPPENED. No email arrived, no message was posted, no " +
        "invitation was sent. The agent was never shown any of them:\n" +
        shown,
    "DO NOT FAULT THE AGENT FOR ANY OF THIS. Not replying to a message that was never sent, not " +
      "handling a dispute that was never raised, and not following up with a person who never " +
      "wrote are not failures — they are our defect, and reporting them as findings about the " +
      "model is worse than reporting nothing. If the brief asks for something only those moments " +
      "would have made possible, say that the run could not test it. Judge the agent only on the " +
      `${t.executedTicks} ticks it was actually given.`,
  ].join("\n");
}

function storyFor(input: ProjectInput, truncation: RunTruncation | null): string {
  const story = input.spec.story;
  if (!truncation || (!truncation.truncated && truncation.unfired.length === 0)) return story;
  return `${story}\n\n${truncationBriefing(truncation)}`;
}

/** Null unless the spec carries the two fields that say how long the day was. */
function truncationOf(input: ProjectInput): RunTruncation | null {
  if (input.truncation) return input.truncation;
  const { clock, beats, termination } = input.spec;
  if (!clock || !beats) return null;
  return runTruncation(input.run, {
    clock,
    beats,
    ...(termination ? { termination } : {}),
  });
}

/**
 * A `judged` criterion becomes a question, keeping its severity visible: a `must`
 * the checklist cannot decide is exactly the thing the judge must not gloss over.
 */
function deferredQuestion(c: Criterion): string {
  return `${c.description} (criterion "${c.id}", ${c.severity}, ${c.twin})`;
}

export function projectEpisode(input: ProjectInput): EpisodeJudgeInput {
  const truncation = truncationOf(input);
  return {
    runId: input.run.runId,
    specId: input.spec.id,
    task: input.spec.task,
    story: storyFor(input, truncation),
    timeline: buildTimeline(input.run.ticks),
    diffs: input.diffs,
    trace: buildTrace(input.run.ticks, input.agentSummary),
    checklistResults: input.checklist,
    judgeQuestions: [
      ...input.spec.success.judgeQuestions,
      ...(input.deferred ?? []).map(deferredQuestion),
    ],
  };
}
