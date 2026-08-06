import { endISO, runTruncation, TWIN_NAMES, type RunTruncation } from "@sonata/core";
import type {
  AgentStep,
  BeatBody,
  ByTwin,
  CalendarSnapshot,
  Clock,
  Criterion,
  CriterionResult,
  DirectorEvent,
  EpisodeJudgeInput,
  EpisodeRun,
  EpisodeSpec,
  GmailSnapshot,
  JudgeStep,
  JudgeTrace,
  SlackSnapshot,
  TickRecord,
  TimelineEntry,
  TwinDiff,
  TwinFinalState,
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
// with results summarized to a line, what it said, the per-twin diffs — which are
// ground truth about effects and cost almost nothing, because a diff lists what
// changed and counts what did not — and where each twin ended up, narrowed to the
// day, because a diff cannot answer a question about what was left untouched.

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

// ---------------------------------------------------------------------------
// WHERE THINGS ENDED UP. The after-snapshot, narrowed.
//
// The diffs answer "what moved". They cannot answer "what was left", because
// what the agent never touched leaves no row in a diff — and a criterion like
// "no customer is left without a response" is a question about exactly that.
// So the end state goes in alongside, and the only real problem is size.
//
// Measured on `run_msg8vldg_l9hj`'s own after-snapshots: gmail 8,189 chars over
// 20 threads, slack 10,566 over 30 messages, calendar 101,912 over 250 events.
// Attached raw that is ~30k tokens, 85% of it diary from days the run never
// reached, and it would crowd out the trace.
//
// The rule is RELEVANCE, not a flat cap — keep what the day could plausibly be
// about, drop what it demonstrably was not:
//
//   calendar  events inside the simulated day plus a margin, and every event the
//             run touched wherever it landed (a meeting pushed to next week is
//             the agent's doing and has to stay visible)
//   gmail     the inbox, plus every thread the run touched. Not time-windowed:
//             a thread that has sat unanswered since last month is precisely the
//             signal this section exists to carry
//   slack     every channel — the list is short and its counts are state — plus
//             messages inside the same window
//
// The window's ends come from the spec's clock, so a scenario simulating three
// days gets a three-day window with nobody editing this file.
//
// What that costs, measured on the same run: gmail 8,189 -> 6,231 (11 of 20
// threads), slack 10,566 -> 9,279 (26 of 30 messages), calendar 101,912 -> 3,892
// (10 of 250 events). 120,667 chars of snapshot down to 19,402, and the whole
// rendered section lands at 14.7k — about 3.7k tokens, next to the ~30k that
// attaching the three raw would have cost. Almost all of the saving is diary the
// run never reached, which is the point: relevance pays for itself here and a
// flat cap would have been paid for out of the day the judge is assessing.
// ---------------------------------------------------------------------------

/**
 * How far either side of the simulated day an end state still counts as today's.
 *
 * A day, because that is the reach of a criterion about a day: "did it push the
 * 3pm to tomorrow morning", "was this the follow-up to yesterday's review". Only
 * the shoulder is fixed; the ends it hangs off are the clock's.
 */
const WINDOW_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Gmail's own name for the inbox — a thread out of it is a thread filed away. */
const INBOX = "INBOX";

interface DayWindow {
  from: number;
  to: number;
  /** As the judge is shown it, so the prompt never re-formats these two instants. */
  label: string;
}

/** Milliseconds, or null for anything unparseable. */
function instant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The scheduled day. Null on a clock the core rejects — an offsetless start. */
function clockSpan(clock: Clock | undefined): { from: number; to: number } | null {
  if (!clock) return null;
  try {
    const from = instant(clock.startISO);
    const to = instant(endISO(clock));
    return from === null || to === null ? null : { from, to };
  } catch {
    return null;
  }
}

/**
 * The day the run actually simulated, from the ticks themselves. The fallback for
 * a caller that passes no clock — and it has to be the SIMULATED time, never
 * `capturedAt`: on `run_msg8vldg_l9hj` the snapshots were captured on 2026-08-05
 * for a day set on 2026-08-06, so anchoring on the wall clock would window the day
 * out of its own diary.
 */
function tickSpan(ticks: TickRecord[]): { from: number; to: number } | null {
  const times = ticks.map((t) => instant(t.simTimeISO)).filter((n): n is number => n !== null);
  return times.length === 0 ? null : { from: Math.min(...times), to: Math.max(...times) };
}

/** Null when nothing dates the day; the caller then narrows by nothing. */
function dayWindow(input: ProjectInput): DayWindow | null {
  const span = clockSpan(input.spec.clock) ?? tickSpan(input.run.ticks);
  if (!span) return null;
  const from = span.from - WINDOW_MARGIN_MS;
  const to = span.to + WINDOW_MARGIN_MS;
  return {
    from,
    to,
    label: `${new Date(from).toISOString()} to ${new Date(to).toISOString()}`,
  };
}

function inWindow(ms: number | null, w: DayWindow | null): boolean {
  // Undateable, or nothing to date it against: keep it. A filter that cannot tell
  // must not be the thing that hides the day.
  if (w === null || ms === null) return true;
  return ms >= w.from && ms <= w.to;
}

/** Every thread id the diff says the run reached, however it reached it. */
function touchedThreads(d: TwinDiff | undefined): Set<string> {
  if (d?.twin !== "gmail") return new Set();
  return new Set([...d.added, ...d.removed, ...d.changed].map((t) => t.threadId));
}

/** Every event id the diff says the run reached. */
function touchedEvents(d: TwinDiff | undefined): Set<string> {
  if (d?.twin !== "calendar") return new Set();
  return new Set([
    ...d.created.map((e) => e.eventId),
    ...d.cancelled.map((e) => e.eventId),
    ...d.moved.map((e) => e.eventId),
    ...d.attendeesChanged.map((e) => e.eventId),
    ...d.rsvpChanged.map((e) => e.eventId),
  ]);
}

function gmailFinalState(s: GmailSnapshot, touched: Set<string>): TwinFinalState {
  const threads = s.threads.filter((t) => t.labels.includes(INBOX) || touched.has(t.threadId));
  return {
    state: {
      ...s,
      threads: threads.map((t) => ({ ...t, subject: truncate(t.subject, MAX_LINE) })),
      // Drafts stay whole: a draft is the tell for "wrote it but would not send
      // it", which is the autonomy question, and the list is short by nature.
      drafts: s.drafts.map((d) => ({ ...d, excerpt: truncate(d.excerpt, MAX_LINE) })),
    },
    coverage: { shown: threads.length, total: s.threads.length },
    kept: "the inbox, plus every thread the run touched",
  };
}

/** Slack stamps a message with epoch SECONDS as a string, e.g. "1786013100.000003". */
function slackInstant(ts: string): number | null {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function slackFinalState(s: SlackSnapshot, w: DayWindow | null): TwinFinalState {
  const messages = s.messages.filter((m) => inWindow(slackInstant(m.ts), w));
  return {
    state: {
      ...s,
      messages: messages.map((m) => ({ ...m, text: truncate(m.text, MAX_LINE) })),
    },
    coverage: { shown: messages.length, total: s.messages.length },
    kept: w ? `messages posted ${w.label}` : "every message the snapshot held",
  };
}

function calendarFinalState(
  s: CalendarSnapshot,
  w: DayWindow | null,
  touched: Set<string>,
): TwinFinalState {
  const events = s.events.filter(
    (e) => touched.has(e.eventId) || inWindow(instant(e.startISO), w),
  );
  return {
    state: { ...s, events: events.map((e) => ({ ...e, title: truncate(e.title, MAX_LINE) })) },
    coverage: { shown: events.length, total: s.events.length },
    kept: w
      ? `events starting ${w.label}, plus every event the run touched wherever it landed`
      : "every event the snapshot held",
  };
}

/**
 * The end of the day on each surface, narrowed.
 *
 * A twin whose after-snapshot never landed is simply absent, and the engine's
 * pairing is why: it stores a twin's snapshots only when BOTH the before and the
 * after came back, so a capture that failed at the end of the day leaves no entry
 * at all. Absent is the honest answer — the prompt turns it into a sentence rather
 * than a surface with nothing on it.
 */
export function buildFinalState(input: ProjectInput): ByTwin<TwinFinalState> {
  const w = dayWindow(input);
  const out: ByTwin<TwinFinalState> = {};
  for (const name of TWIN_NAMES) {
    const after = input.run.snapshots[name]?.after;
    if (!after) continue;
    const diff = input.diffs[name];
    if (after.twin === "gmail") out.gmail = gmailFinalState(after, touchedThreads(diff));
    else if (after.twin === "slack") out.slack = slackFinalState(after, w);
    else out.calendar = calendarFinalState(after, w, touchedEvents(diff));
  }
  return out;
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
    finalState: buildFinalState(input),
    trace: buildTrace(input.run.ticks, input.agentSummary),
    checklistResults: input.checklist,
    judgeQuestions: [
      ...input.spec.success.judgeQuestions,
      ...(input.deferred ?? []).map(deferredQuestion),
    ],
  };
}
