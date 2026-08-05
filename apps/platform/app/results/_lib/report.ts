import {
  getFailureMode,
  runExecution,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type TwinName,
} from "@sonata/core";
import type { RunBrief } from "./artifacts";
import { buildMoments, type Moment } from "./moments";
import { formatDuration, formatPercent, formatSimTime, formatUsd, UNKNOWN } from "./summary";

// The one artifact a run makes that a person outside the room can read.
//
// Every other projection in this folder feeds a screen. This feeds a document,
// and the document answers one question: **how capable is this AI coworker?**
// Not "what did our harness score" — a prospect deciding whether to let an agent
// into their inbox is really asking what they would ask about a new hire. Can it
// do the job. How much supervising does it need. What would I have had to catch.
// What did it cost me. What access does it actually want.
//
// So the sections here are a performance review, not a test log, and the words
// are the ones a manager would use. Our own vocabulary — criteria, ticks, beats,
// failure-mode ids, step numbers — is machinery. It is deliberately scrubbed on
// the way out (`readable`), because the moment a partner reads "per deterministic
// check c1" the document stops being about their agent and starts being about us.
//
// It invents nothing. Every number, action and scope is read straight off the
// artifact — that is what lets this read as diligence rather than as a pitch.

const TWIN_ORDER: readonly TwinName[] = ["gmail", "slack", "calendar"];
const TWIN_LABEL: Record<TwinName, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
};

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/** Whitespace-collapse onto one line, without cutting. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Strip our machinery out of prose written by the judge or a checker.
 *
 * The judge cites its evidence as step and tick numbers — rigour that is real,
 * and unreadable to anyone outside this tool. The document says once, at the
 * end, that every claim is traceable in the replay; here the references come out
 * so the sentences can be read as sentences.
 */
function readable(text: string): string {
  return flat(text)
    // "(step 55)", "(steps 4-6, 20-21)", "(tick 3)", "(t5 scripted beat)"
    .replace(/\s*\((?:at\s+)?(?:steps?|ticks?|t\d)\b[^)]*\)/gi, "")
    // "(per deterministic check c1)", "(check c3)"
    .replace(/\s*\((?:per\s+)?(?:deterministic\s+)?checks?\s+c\d+[^)]*\)/gi, "")
    // Authored criteria set deadlines in ticks — "…a written summary by tick 16".
    // The deadline is real; the unit is ours, and it means nothing to a reader.
    .replace(/\s*\b(?:by|at|before|within|after|on)\s+ticks?\s+\d+/gi, "")
    // A "tick" is our unit for a slice of the simulated day. The judge writes in
    // it fluently; nobody outside this tool has ever heard of it.
    .replace(/\b(?:each|every)\s+tick\b/gi, "each time it checked in")
    .replace(/\bper\s+tick\b/gi, "each time it checked in")
    .replace(/\bticks?\b/gi, "check-in")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** As `readable`, but capped — for one-line evidence under a bullet. */
function oneLine(text: string, max = 200): string {
  const one = readable(text);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * Evidence a person can read. Checkers and judges both emit two kinds of string:
 * a quote from the world ("Tuesday 3 PM works.") and a diagnostic about the
 * check itself ("criterion names no beat ref"). The first is evidence; the
 * second is our plumbing, and putting it in front of a prospect reads as a bug.
 */
const PLUMBING = [
  /criterion names no/i,
  /appears in none of the/i,
  /\bthing\(s\)\b/i,
  /^\s*\w+\(\{/, // a raw tool call: create_draft({"to":…
  /->/,
  /\bno beat ref\b/i,
];

function usableEvidence(evidence: string[] | undefined): string | null {
  for (const raw of evidence ?? []) {
    const text = flat(raw);
    if (!text || PLUMBING.some((p) => p.test(text))) continue;
    return oneLine(text);
  }
  return null;
}

function sentenceCase(text: string): string {
  const t = flat(text);
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// The access map — the permission ask, derived from behaviour
// ---------------------------------------------------------------------------

interface TwinAccess {
  twin: TwinName;
  reads: string[];
  writes: string[];
}

/**
 * What the workflow actually needed. Each tool step records the surface it hit
 * and whether it changed anything, so the scope list is just the distinct tools
 * fired, split on that flag. A surface the agent never touched never appears —
 * the ask is exactly the day's footprint, nothing wider.
 */
function accessMap(run: EpisodeRun): TwinAccess[] {
  const reads = new Map<TwinName, Set<string>>();
  const writes = new Map<TwinName, Set<string>>();

  for (const tick of run.ticks) {
    for (const step of tick.agentSteps) {
      if (step.kind !== "tool" || !step.twin) continue;
      const bucket = step.isMutation ? writes : reads;
      const set = bucket.get(step.twin) ?? new Set<string>();
      set.add(step.name);
      bucket.set(step.twin, set);
    }
  }

  const touched = new Set<TwinName>([...reads.keys(), ...writes.keys()]);
  return TWIN_ORDER.filter((t) => touched.has(t)).map((twin) => ({
    twin,
    // A tool used both ways counts as a write: the stronger scope is the one
    // that has to be granted, and understating the ask helps nobody.
    reads: [...(reads.get(twin) ?? [])].filter((n) => !writes.get(twin)?.has(n)).sort(),
    writes: [...(writes.get(twin) ?? [])].sort(),
  }));
}

function accessSentence(access: TwinAccess[]): string {
  const write = access.filter((a) => a.writes.length > 0).map((a) => TWIN_LABEL[a.twin]);
  const read = access.filter((a) => a.writes.length === 0).map((a) => TWIN_LABEL[a.twin]);
  const parts: string[] = [];
  if (write.length > 0) parts.push(`**permission to act in ${andList(write)}**`);
  if (read.length > 0) parts.push(`**read-only access to ${andList(read)}**`);
  if (parts.length === 0) return "no connected system at all — it worked the day without touching one.";
  return `${parts.join(", and ")}.`;
}

// ---------------------------------------------------------------------------
// What the agent did
// ---------------------------------------------------------------------------

/** The consequential half of the day: what it *did*, plus every hand-back.
 *  Reads are the machinery; these are the decisions a manager would review. */
function decisions(moments: Moment[]): Moment[] {
  return moments.filter((m) => m.source === "agent" && (m.isMutation || m.step?.kind === "escalation"));
}

/** A tool name is an API surface; a manager reads intent. Unmapped names fall
 *  back to the name with its underscores opened out — legible, never blank. */
const TOOL_PHRASE: Record<string, string> = {
  send_reply: "replied to an email",
  send_email: "sent an email",
  create_draft: "left an email drafted but unsent",
  update_draft: "revised a draft",
  reply_in_thread: "replied in a Slack thread",
  send_message: "posted in Slack",
  add_reaction: "reacted in Slack",
  create_event: "put a meeting in the calendar",
  move_event: "moved a meeting",
  cancel_event: "cancelled a meeting",
  update_event: "changed a meeting",
  label_thread: "labelled a thread",
  archive_thread: "archived a thread",
};

function phraseOf(m: Moment): string {
  if (m.step?.kind === "escalation") return "handed the job back to a human";
  const name = m.step?.kind === "tool" ? m.step.name : m.title;
  return TOOL_PHRASE[name] ?? name.replace(/_/g, " ");
}

/**
 * The day's rhythm, an hour at a time. Fourteen separate "replied in a Slack
 * thread" lines is a transcript, not a story; what a reader wants is the shape —
 * when it was busy, on what, and where the notable single moments fall.
 */
function cadence(acts: Moment[], offsetMinutes: number): string[] {
  const byClock = new Map<string, Moment[]>();
  for (const m of acts) {
    const clock = formatSimTime(m.simTimeISO, offsetMinutes);
    byClock.set(clock, [...(byClock.get(clock) ?? []), m]);
  }

  return [...byClock.entries()].map(([clock, group]) => {
    const tally = new Map<string, number>();
    for (const m of group) {
      const key = `${phraseOf(m)}|${m.twin ?? ""}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const parts = [...tally.entries()].map(([key, n]) => {
      const phrase = key.split("|")[0];
      return n === 1 ? phrase : `${phrase} ×${n}`;
    });
    return `- **${clock}** — ${sentenceCase(parts.join("; "))}`;
  });
}

// ---------------------------------------------------------------------------
// Capability read
// ---------------------------------------------------------------------------

interface Capability {
  /** Inbound demands the world put on it: scripted events plus people reacting. */
  inbound: number;
  reads: number;
  writes: number;
  escalations: number;
  /** Findings a manager would have had to catch — the supervision burden. */
  needsCorrection: number;
  minorNotes: number;
  /** Minutes of the working day it covered, from the simulated clock. */
  simMinutes: number | null;
}

function capability(run: EpisodeRun, judge: EpisodeJudgeReport | null): Capability {
  let inbound = 0;
  let reads = 0;
  let writes = 0;
  let escalations = 0;

  for (const tick of run.ticks) {
    inbound += tick.beatsFired.length + tick.directorEvents.length;
    for (const step of tick.agentSteps) {
      if (step.kind === "escalation") escalations++;
      else if (step.kind === "tool") step.isMutation ? writes++ : reads++;
    }
  }

  const all = [...(judge?.findings ?? []), ...(judge?.otherFindings ?? [])];
  const needsCorrection = all.filter((f) => f.severity === "critical" || f.severity === "major").length;

  // The simulated day's span, from its own clock: the first tick to one tick
  // past the last, so a six-tick day reads as its full length and not as the
  // gap between its endpoints.
  const first = run.ticks[0]?.simTimeISO;
  const last = run.ticks[run.ticks.length - 1]?.simTimeISO;
  const second = run.ticks[1]?.simTimeISO;
  let simMinutes: number | null = null;
  if (first && last) {
    const perTick = second ? (Date.parse(second) - Date.parse(first)) / 60_000 : 0;
    const span = (Date.parse(last) - Date.parse(first)) / 60_000 + perTick;
    if (Number.isFinite(span) && span > 0) simMinutes = span;
  }

  return {
    inbound,
    reads,
    writes,
    escalations,
    needsCorrection,
    minorNotes: all.length - needsCorrection,
    simMinutes,
  };
}

function hoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The bottom line, in hiring terms. This is the sentence a partner repeats to
 * their prospect, so it says what the run means rather than what it scored:
 * whether this coworker could be left with the work, and what it would take.
 */
function bottomLine(
  outcome: "pass" | "partial" | "fail" | null,
  cap: Capability,
  /** Why there is no verdict, when there is none. Never "not assessed yet": a
   *  run that never executed is not waiting on us, and a reader must not be left
   *  expecting a number that is never coming. */
  noResult?: string | null,
): string {
  if (outcome === null) {
    return noResult ?? "This run produced no result, so there is nothing to assess.";
  }
  const supervision =
    cap.needsCorrection === 0
      ? "Nothing it did would have needed correcting."
      : `${count(cap.needsCorrection, "decision")} would have needed a manager to catch ${
          cap.needsCorrection === 1 ? "it" : "them"
        }.`;

  if (outcome === "pass") {
    return `**It did the job.** ${supervision}`;
  }
  if (outcome === "partial") {
    return `**It did much of the job, but not all of it.** ${supervision}`;
  }
  return `**It could not be left to run this workflow alone.** ${supervision}`;
}

// ---------------------------------------------------------------------------

function criterionLine(c: CriterionResult): string {
  const evidence = usableEvidence(c.evidence ? [c.evidence] : []);
  const weight = c.severity === "must" ? "" : " _(nice to have)_";
  return `- ${sentenceCase(readable(c.description))}${weight}${evidence ? ` — ${evidence}` : ""}`;
}

/**
 * The whole assessment, as Markdown. Given a finished run and its brief, returns
 * a document ready to hand to a design partner — or to turn into a PDF. Safe on
 * an unfinished run: sections without evidence are dropped, never faked.
 */
export function buildRunReport(run: EpisodeRun, brief: RunBrief): string {
  const v = run.verdict;
  const judge = v?.judge ?? null;
  const offset = brief.offsetMinutes;
  const moments = buildMoments(run, brief.people);
  const acts = decisions(moments);
  const access = accessMap(run);
  const cap = capability(run, judge);
  const durationMs = run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null;

  const first = run.ticks[0]?.simTimeISO;
  const last = run.ticks[run.ticks.length - 1]?.simTimeISO;
  const dayRange =
    first && last ? `${formatSimTime(first, offset)}–${formatSimTime(last, offset)}` : UNKNOWN;

  const out: string[] = [];
  const p = (line = "") => out.push(line);

  // --- Title and bottom line -------------------------------------------------
  p(`# How the AI coworker performed — ${run.specTitle}`);
  p();
  p(
    `An independent test of **${run.model}** doing a real workday's work, inside a ` +
      `working clone of ${andList(access.map((a) => TWIN_LABEL[a.twin]))} seeded with realistic ` +
      `history. No production system was connected and no access was granted to run this.`,
  );
  p();
  p(bottomLine(v?.outcome ?? null, cap, runExecution(run).reason));

  // --- Scorecard -------------------------------------------------------------
  if (v) {
    p();
    p(`## At a glance`);
    p();
    p(`| | |`);
    p(`|---|---|`);
    p(`| **Got the job done** | ${formatPercent(v.score)} of what the day required |`);
    p(`| **Worked unsupervised** | ${formatPercent(v.autonomy)} of the way through |`);
    p(
      `| **Judgement calls to correct** | ${
        cap.needsCorrection === 0 ? "none" : count(cap.needsCorrection, "call")
      }${cap.minorNotes > 0 ? `, plus ${count(cap.minorNotes, "minor note")}` : ""} |`,
    );
    p(
      `| **Workload handled** | ${count(cap.inbound, "incoming demand")}, ${count(
        cap.writes,
        "action",
      )} taken across ${count(access.length, "system")} |`,
    );
    p(
      `| **Speed** | ${
        cap.simMinutes ? `${hoursMinutes(cap.simMinutes)} of work` : "the day"
      } in ${formatDuration(durationMs)} of real time |`,
    );
    p(`| **Cost** | ${formatUsd(v.cost.usd)} |`);
  }

  // --- The job ---------------------------------------------------------------
  if (brief.task || brief.story) {
    p();
    p(`## The job it was given`);
    if (brief.task) {
      p();
      p(readable(brief.task));
    }
    if (brief.story) {
      p();
      p(`**The day it walked into.** ${readable(brief.story)}`);
    }
  }

  // --- How it performed ------------------------------------------------------
  if (judge?.summary) {
    p();
    p(`## How it performed`);
    p();
    p(readable(judge.summary));
  }

  // --- Strengths -------------------------------------------------------------
  const passed = (v?.checklist ?? []).filter((c) => c.status === "passed");
  if (passed.length > 0) {
    p();
    p(`## What it got right`);
    p();
    p(`Checked against the state of the world it left behind, not against what it claimed:`);
    p();
    for (const c of passed) p(criterionLine(c));
  }

  // --- Supervision burden ----------------------------------------------------
  // `status === "failed"`, not `!passed`. This document goes outside the room,
  // and a criterion nothing could decide printed under "work that never landed"
  // is an accusation the artifact cannot support — the reader has no way to tell
  // it apart from a real miss. Undecided criteria are named at the end instead,
  // as the limit of the test rather than as a fault of the agent.
  const failed = (v?.checklist ?? []).filter((c) => c.status === "failed");
  const undecided = (v?.checklist ?? []).filter((c) => c.status === "notApplicable");
  const findings = judge ? [...judge.findings, ...judge.otherFindings] : [];
  if (failed.length > 0 || findings.length > 0) {
    p();
    p(`## Where a human would have had to step in`);
    p();
    p(
      `This is the supervision cost of putting this coworker on this workflow today — ` +
        `and all of it surfaced here, in the clone, rather than in a customer's inbox.`,
    );

    if (findings.length > 0) {
      p();
      p(`**Judgement calls that went wrong**`);
      p();
      for (const f of judge?.findings ?? []) {
        const label = getFailureMode(f.mode)?.label ?? f.mode;
        const ev = usableEvidence(f.evidence);
        p(`- **${sentenceCase(label)}** _(${f.severity})_${ev ? ` — ${ev}` : ""}`);
      }
      for (const f of judge?.otherFindings ?? []) {
        const ev = usableEvidence(f.evidence);
        p(`- **${sentenceCase(f.label)}** _(${f.severity})_${ev ? ` — ${ev}` : ""}`);
      }
    }

    if (failed.length > 0) {
      p();
      p(`**Work the day needed that never landed**`);
      p();
      for (const c of failed) p(criterionLine(c));
    }
  }

  // --- How it worked the day -------------------------------------------------
  p();
  p(`## How it worked the day`);
  p();
  p(
    `Between ${dayRange} it checked the systems ${count(cap.reads, "time")} and acted ` +
      `${count(cap.writes, "time")}, ${
        cap.escalations > 0
          ? `and asked a human for help ${count(cap.escalations, "time")}`
          : `and never asked a human for help`
      }.`,
  );
  p();
  if (acts.length === 0) {
    p(`- It changed nothing anywhere — the day went by without an action.`);
  } else {
    for (const line of cadence(acts, offset)) p(line);
  }

  // --- Access ----------------------------------------------------------------
  p();
  p(`## The access it actually needed`);
  p();
  p(
    `Rather than asking for everything up front, this is what the workflow used when it ran: ` +
      `${accessSentence(access)} That is the ask to start with — and it can widen later, ` +
      `against evidence like this rather than ahead of it.`,
  );
  for (const a of access) {
    p();
    p(
      `**${TWIN_LABEL[a.twin]}** — ${
        a.writes.length > 0 ? "needs to act, and to read" : "only ever read; never changed anything"
      }`,
    );
    if (a.writes.length > 0) p(`- Acts: ${a.writes.map((n) => `\`${n}\``).join(", ")}`);
    if (a.reads.length > 0) p(`- Reads: ${a.reads.map((n) => `\`${n}\``).join(", ")}`);
  }

  // --- Cost ------------------------------------------------------------------
  if (v) {
    p();
    p(`## What it cost`);
    p();
    p(
      `${formatUsd(v.cost.usd)} to work through ${
        cap.simMinutes ? hoursMinutes(cap.simMinutes) : "the day"
      } of this job${
        cap.writes > 0 ? `, across ${count(cap.writes, "action")} taken` : ""
      }. Set against what the same hours cost in salary, that is the number to put ` +
        `next to the price — and it is measured here per workflow, not estimated.`,
    );
  }

  // --- Diligence Q&A ---------------------------------------------------------
  if (judge && judge.answers.length > 0) {
    p();
    p(`## Questions we put to the assessor`);
    p();
    for (const a of judge.answers) {
      p(`**${readable(a.question)}**`);
      p();
      p(readable(a.answer));
      p();
    }
  }

  // --- The limits of the test ------------------------------------------------
  if (undecided.length > 0) {
    p();
    p(`## What this test could not tell`);
    p();
    p(
      `The day left no evidence either way on ${count(undecided.length, "check")}. ` +
        `${undecided.length === 1 ? "It is" : "They are"} not counted for or against the ` +
        `coworker anywhere above — an unanswered question is not a failure, and reporting it ` +
        `as one would overstate what this test actually measured:`,
    );
    p();
    for (const c of undecided) p(`- ${sentenceCase(readable(c.description))}`);
  }

  // --- Method ----------------------------------------------------------------
  p();
  p(`## How this was tested`);
  p();
  p(
    `The coworker worked a simulated day inside clones of ` +
      `${andList(access.map((a) => TWIN_LABEL[a.twin]))}, seeded with a company, its people and ` +
      `their history. The people in it answer back: colleagues reply, escalate and change their ` +
      `minds in response to what the agent does, so this measures judgement under a day that ` +
      `pushes back — not a scripted demo. Nothing touched a live account.`,
  );
  p();
  p(
    `Every claim above is traceable to the moment it happened in the run replay. The same day ` +
      `can be re-run against any model, and becomes a regression test: proof that a new version ` +
      `still handles this workflow before it goes anywhere near a real inbox.`,
  );

  return `${out.join("\n")}\n`;
}
