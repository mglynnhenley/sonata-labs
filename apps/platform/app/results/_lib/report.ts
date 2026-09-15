import {
  getFailureMode,
  scoreChecklist,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type TwinName,
  type VerdictOutcome,
} from "@sonata/core";
import type { RunBrief } from "./artifacts";
import { buildMoments, type Moment } from "./moments";
import { formatDuration, formatPercent, formatSimTime, formatUsd, summarizeRun, UNKNOWN } from "./summary";
import { judgeSight, sliceSentence } from "../_components/harness";
import { headlineUsd, type CostReport } from "./cost";

// The portable assessment. Keep evidence anchors, task boundaries and measurement
// limits readable in the exported document as well as the interactive report.

const TWIN_ORDER: readonly TwinName[] = [
  "gmail",
  "slack",
  "calendar",
  "attio",
  "google-docs",
  "google-ads",
  "linkedin",
  "excel",
];
const TWIN_LABEL: Record<TwinName, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  attio: "Attio",
  "google-docs": "Google Docs",
  "google-ads": "Google Ads",
  linkedin: "LinkedIn",
  excel: "Excel",
  desk: "Desk",
};

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/** Whitespace-collapse onto one line, without cutting. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readable(text: string): string {
  // Deadlines and evidence anchors are part of the claim. Removing "by tick
  // 16" made an on-time criterion indistinguishable from eventual completion.
  return flat(text);
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
  create_draft: "prepared an email draft",
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
  if (m.step?.kind === "escalation") return "recorded a request for human help";
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
    inbound += tick.beatsFired.filter((event) => !event.error).length +
      tick.directorEvents.filter((event) => !event.error).length;
    for (const step of tick.agentSteps) {
      if (step.kind === "escalation") escalations++;
      else if (step.kind === "tool") step.isMutation ? writes++ : reads++;
    }
  }

  const all = [...(judge?.findings ?? []), ...(judge?.otherFindings ?? [])];
  const needsCorrection = all.filter((f) => f.severity === "critical" || f.severity === "major").length;

  // Observed clock span only. Do not invent a final work interval: an event-
  // driven run can have uneven gaps and the last interval may be unfinished.
  const first = run.ticks[0]?.simTimeISO;
  const last = run.ticks[run.ticks.length - 1]?.simTimeISO;
  let simMinutes: number | null = null;
  if (first && last) {
    const span = (Date.parse(last) - Date.parse(first)) / 60_000;
    if (Number.isFinite(span) && span >= 0) simMinutes = span;
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
  outcome: VerdictOutcome | null,
  cap: Capability,
  /** The verdict's own rows, for the one sentence that has to count them. */
  checklist: CriterionResult[],
  /** Why there is no verdict, when there is none. Never "not assessed yet": a
   *  run that never executed is not waiting on us, and a reader must not be left
   *  expecting a number that is never coming. */
  noResult?: string | null,
): string {
  if (outcome === null) {
    return noResult ?? "This run produced no result, so there is nothing to assess.";
  }
  // Before the supervision sentence, because there is nothing to supervise a
  // judgement of: an inconclusive run has not been assessed, and printing "it
  // could not be left to run this alone" — where this used to land — is an
  // accusation the artifact does not support. The document says what is missing
  // and sends the reader to the findings, which ARE evidence.
  if (outcome === "inconclusive") {
    const { decided, total, undecidedMusts } = scoreChecklist(checklist);
    const what =
      undecidedMusts > 0
        ? `${count(undecidedMusts, "of the day's must-dos")} could not be checked at all`
        : `only ${decided} of ${total} criteria could be checked at all`;
    return (
      `**This run has not been graded.** ${what}, so nothing here shows whether the job was ` +
      `done. What follows is what the day contained, not a verdict on it — read the findings ` +
      `and decide for yourself.`
    );
  }
  const supervision = cap.needsCorrection > 0
    ? ` The assessor reported ${count(cap.needsCorrection, "major or critical finding")}; inspect the evidence below.`
    : "";

  if (outcome === "pass") {
    return `**The run passed its checked requirements.**${supervision}`;
  }
  if (outcome === "partial") {
    return `**The run met some, but not all, checked requirements.**${supervision}`;
  }
  return `**The run failed its declared requirements.**${supervision}`;
}

// ---------------------------------------------------------------------------

function criterionLine(c: CriterionResult): string {
  const evidence = usableEvidence(c.evidence ? [c.evidence] : []);
  const weight = c.severity === "must" ? "" : " _(nice to have)_";
  return `- **${c.id}:** ${sentenceCase(readable(c.description))}${weight}${evidence ? ` — ${evidence}` : ""}${c.tick !== undefined ? ` _(tick ${c.tick})_` : ""}`;
}

/**
 * The whole assessment, as Markdown. Given a finished run and its brief, returns
 * a document ready to hand to a design partner — or to turn into a PDF. Safe on
 * an unfinished run: sections without evidence are dropped, never faked.
 */
export function buildRunReport(run: EpisodeRun, brief: RunBrief, cost?: CostReport): string {
  const summary = summarizeRun(run);
  const v = summary.noResult ? null : run.verdict;
  const judge = v?.judge ?? null;
  const offset = brief.offsetMinutes;
  const moments = buildMoments(run, brief.people);
  const acts = decisions(moments);
  const access = accessMap(run);
  const cap = capability(run, judge);
  const recordedUsd = cost ? headlineUsd(cost) : v?.cost.usd ?? null;
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
  p(`A recorded business simulation using **${run.model}**. Run: \`${run.runId}\`. ` +
    `The assessment below is limited to the scenario requirements and evidence saved with this run.`);
  p();
  p(bottomLine(v?.outcome ?? null, cap, v?.checklist ?? [], summary.noResult));
  if (run.error) {
    p();
    p(`**Run interruption:** ${flat(run.error)}. This is not an agent task-failure finding.`);
  }

  // --- Scorecard -------------------------------------------------------------
  if (v) {
    p();
    p(`## At a glance`);
    p();
    p(`| | |`);
    p(`|---|---|`);
    const coverage = scoreChecklist(v.checklist);
    p(`| **Checklist score** | ${coverage.decided > 0 ? formatPercent(coverage.score) : "Unmeasured"} by weight; ${coverage.decided} of ${coverage.total} criteria decided |`);
    p(
      `| **Assessor findings** | ${
        !judge ? "Not assessed" : cap.needsCorrection === 0 ? "No major or critical findings recorded" : count(cap.needsCorrection, "major or critical finding")
      }${cap.minorNotes > 0 ? `, plus ${count(cap.minorNotes, "minor note")}` : ""} |`,
    );
    p(
      `| **Recorded activity** | ${count(cap.inbound, "world event")}, ${count(
        cap.writes,
        "mutation attempt",
      )} across ${count(access.length, "system")} |`,
    );
    p(
      `| **Observed simulated clock span** | ${cap.simMinutes !== null ? hoursMinutes(cap.simMinutes) : UNKNOWN} between first and last recorded tick |`,
    );
    p(`| **Recorded elapsed time** | ${formatDuration(durationMs)} |`);
    p(`| **Recorded run cost** | ${formatUsd(recordedUsd)}; scope described below |`);
  }

  p();
  p(`**How to interpret this result.** Simulated clock time is not measured human working time. ` +
    `Required human review, an approved draft, or a case correctly held pending evidence can satisfy the task. ` +
    `An open item alone is not a failure or proof of a justified hold; the criterion and supporting evidence determine the outcome.`);
  const sight = judgeSight(judge);
  if (sight) {
    p();
    p(sight.kind === "partial"
      ? `**Assessor coverage is partial:** ${sight.missing.map(sliceSentence).join("; ")}. Its narrative describes that sample.`
      : `**Assessor coverage was not recorded.** We cannot confirm how much of the saved evidence its narrative considered.`);
  }
  const observationGaps = run.ticks.flatMap(t => (t.observedActions ?? []).filter(a => a.observationError).map(a => ({ tick: t.tick, why: a.observationError! })));
  if (observationGaps.length > 0) {
    p();
    p(`**Colleague observation gaps:** some agent communications could not be supplied to the simulated colleagues. Missing responses cannot establish an agent failure without independent evidence.`);
    p();
    for (const gap of observationGaps) p(`- Tick ${gap.tick}: ${flat(gap.why)}`);
  }

  // --- The job ---------------------------------------------------------------
  if (brief.task || brief.story) {
    p();
    p(`## The job it was given`);
    if (brief.task) {
      p();
      p(readable(brief.task));
    }
    // The brief as a list of jobs, so the reader can check it against their own
    // idea of the day before they read a word about the agent. Absent on reports
    // written before the restatement was broken up.
    if (judge?.taskPoints?.length) {
      p();
      p(`**What that came down to**`);
      p();
      for (const point of judge.taskPoints) p(`- ${readable(point)}`);
    }
    if (judge?.taskAmbiguities?.length) {
      p();
      p(`**What the brief left unclear** — ours, not the agent's:`);
      p();
      for (const point of judge.taskAmbiguities) p(`- ${readable(point)}`);
    }
    if (brief.story) {
      p();
      p(`**The day it walked into.** ${readable(brief.story)}`);
    }
  }

  // --- How it performed ------------------------------------------------------
  if (judge?.summary || judge?.did?.length || judge?.didNot?.length) {
    p();
    p(`## How it performed`);
    if (judge?.summary) {
      p();
      p(readable(judge.summary));
    }
    if (judge?.did?.length) {
      p();
      p(`**What it did**`);
      p();
      for (const item of judge.did) p(`- ${readable(item)}`);
    }
    if (judge?.didNot?.length) {
      p();
      p(`**What it left**`);
      p();
      for (const item of judge.didNot) p(`- ${readable(item)}`);
    }
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
    p(`## Requirements missed and assessor findings`);
    p();
    p(
      `Failed checks and assessor findings describe different evidence. Required reviews and ` +
        `legitimate pending work are assessed against the task, not treated as mistakes simply because a human is involved.`,
    );

    if (findings.length > 0) {
      p();
      p(`**Assessor findings**`);
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
      p(`**Requirements not met**`);
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
      `${count(cap.writes, "time")} (mutation attempts), ${
        cap.escalations > 0
          ? `and recorded ${count(cap.escalations, "explicit escalation")}`
          : `with no explicit escalation recorded`
      }.`,
  );
  p();
  if (acts.length === 0) {
    p(`- No mutation attempts or explicit escalations were recorded.`);
  } else {
    for (const line of cadence(acts, offset)) p(line);
  }

  // --- Access ----------------------------------------------------------------
  p();
  p(`## Recorded tool access`);
  p();
  p(
    `The saved tool calls show ${accessSentence(access)} ` +
      `This records access used or attempted; it does not establish the minimum permissions needed for the job.`,
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
  if (v || cost) {
    p();
    p(`## What it cost`);
    p();
    p(
      `${formatUsd(recordedUsd)} is the recorded model cost${cost?.complete ? " across all priced calls in the saved trace" : "; the available record may not cover every call"}. It is not a total operating-cost ` +
        `or salary-saving estimate. The run's cost breakdown shows any separately recorded colleague, ` +
        `agent and judge calls; calls outside the recorder are not measured here.`,
    );
    if (cost?.roles.length) {
      p();
      p(`| Role | Recorded calls | Priced calls | Recorded cost |`);
      p(`|---|---:|---:|---:|`);
      for (const role of cost.roles) p(`| ${role.role} | ${role.calls} | ${role.pricedCalls} | ${formatUsd(role.costUsd)} |`);
    }
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
    for (const c of undecided) p(criterionLine(c));
  }

  // --- Method ----------------------------------------------------------------
  p();
  p(`## How this was tested`);
  p();
  p(
    `The record contains ${count(run.ticks.length, "tick")} of simulated business time. A tick is ` +
      `an engine work interval; step and tick references link claims to the replay. ` +
      `Scripted events and recorded colleague responses supply the world context. ` +
      `The artifact does not establish realistic human work durations or real-duration reliability.`,
  );
  p();
  // Which clock, in the run's own words. Two runs on different policies are
  // different experiments, and a reader comparing them needs to be told before
  // they start rather than after they have drawn a conclusion.
  if (run.timing?.policy === "provider-operations-v1") {
    p(
      `Business time advanced on the experimental provider-operations-v1 clock, at ` +
        `${count(run.timing.workUnitsPerTick, "work unit")} per interval: the agent's own app ` +
        `requests moved the clock, and model latency did not. Those charges are a declared ` +
        `parameter, not a measured conversion from requests to human effort, and results here ` +
        `cannot be compared with a run on the default compressed clock.`,
    );
    p();
  } else if (run.timing?.policy === "compressed-wall-time") {
    p(
      `Business time advanced on the default compressed clock, so model latency, retries and ` +
        `host contention consumed simulated business time along with the agent's own work.`,
    );
    p();
  }
  p(
    `Use the criterion evidence, saved app state and replay to review individual conclusions. ` +
      `A model comparison also requires consistent scenario versions, harness settings, memory policy, ` +
      `budgets and repeated runs. A single simulated episode does not establish production readiness.`,
  );

  return `${out.join("\n")}\n`;
}
