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
  /** Only the four fields the judge sees; a whole spec is welcome and ignored. */
  spec: Pick<EpisodeSpec, "id" | "task" | "story" | "success">;
  run: EpisodeRun;
  /** Per-twin, from each adapter's pure `diff`. Only twins the run used. */
  diffs: ByTwin<TwinDiff>;
  /** What `runChecklist` concluded. Facts by the time they get here. */
  checklist: CriterionResult[];
  /** `judged` criteria the checklist could not decide — asked as questions instead. */
  deferred?: Criterion[];
  /** The agent's closing account of its day, which `EpisodeRun` does not carry. */
  agentSummary?: string;
}

/**
 * A `judged` criterion becomes a question, keeping its severity visible: a `must`
 * the checklist cannot decide is exactly the thing the judge must not gloss over.
 */
function deferredQuestion(c: Criterion): string {
  return `${c.description} (criterion "${c.id}", ${c.severity}, ${c.twin})`;
}

export function projectEpisode(input: ProjectInput): EpisodeJudgeInput {
  return {
    runId: input.run.runId,
    specId: input.spec.id,
    task: input.spec.task,
    story: input.spec.story,
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
