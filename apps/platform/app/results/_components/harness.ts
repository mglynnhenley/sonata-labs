import {
  getFailureMode,
  HARNESS_DEFECT_MARK,
  isHarnessDefect,
  runTruncation,
  tickToISO,
  type Clock,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type RunTruncation,
  type Severity,
  type TwinName,
  type UnfiredWhy,
} from "@sonata/core";
import { formatSimTime } from "../_lib/summary";

// WHOSE FAULT IS THIS ROW?
//
// A run page prints two kinds of bad news that look identical and are not. One is
// the agent's: it read the customer's reply and never answered. The other is
// ours: the day stopped a third of the way through, or the mailbox was never
// captured, so the question was never really put. Printed side by side in one
// list they are read as one list, and a reader carries away "half of this model's
// work was wrong" from evidence that is half ours. For a benchmark meant to be
// published that is disqualifying, so this module is the sorting step every
// surface on the run page runs its rows through first.
//
// It decides nothing new. `isHarnessDefect` is the contract — the checker marks
// its own rows now, in its own voice — and this file adds only what the mark
// cannot reach: artifacts filed before it existed, and the judge's findings,
// which are prose from a model that was told the day was complete.

/** Which of our defects a row is a casualty of. */
export type FaultKind =
  /** The moment it is about never reached the agent — a beat that never fired. */
  | "never-shown"
  /** The clone's state was never captured, so nothing could be checked either way. */
  | "not-captured"
  /** It points at no moment of the part of the day that ran. */
  | "unlocatable";

export const FAULT_LABEL: Record<FaultKind, string> = {
  "never-shown": "never put to the agent",
  "not-captured": "never captured",
  unlocatable: "not in the day that ran",
};

export interface Fault {
  kind: FaultKind;
  /** Our voice, one sentence: what we did wrong and what it cost this row. */
  why: string;
  /**
   * True when `why` IS the checker's own evidence string. Then there is no second,
   * fuller account to offer underneath it — the row would be quoting itself.
   */
  fromChecker: boolean;
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

/**
 * Phrases our own checkers write when the artifact, not the agent, is the
 * problem.
 *
 * A bridge, and deliberately a narrow one. Every row written from now on carries
 * `HARNESS_DEFECT_MARK` and is matched structurally above this; these patterns
 * exist for the runs already on disk, whose rows were written before the checker
 * could say whose fault it was. They match our sentences, not the world's — a
 * criterion the agent genuinely failed never produces any of them.
 */
const NOT_CAPTURED = [
  /\bno (?:gmail|slack|calendar) snapshot in this run\b/i,
  /\bsnapshot was captured for\b/i,
  /\bno audit rows were saved\b/i,
  /\baudit log was not saved\b/i,
  /\bcannot be decided from this file\b/i,
];

const NEVER_SHOWN = [/\bnever fired, or failed when it did\b/i, /\bwas never shown the thing\b/i];

/** The reason without our own marker in front of it. */
function unmarked(evidence: string): string {
  return evidence.startsWith(HARNESS_DEFECT_MARK)
    ? evidence.slice(HARNESS_DEFECT_MARK.length).trim()
    : evidence;
}

/**
 * Checkers write their reasons lower-case and unpunctuated, to be dropped into a
 * larger sentence. Standing on their own in a panel they need both ends.
 */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const head = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/**
 * Is this criterion ours? The reason if so, null if the row is fair game.
 *
 * Only ever `notApplicable` rows: a criterion that passed or failed was decided
 * on evidence, and a decided row is about the agent whatever else went wrong.
 */
export function criterionFault(c: CriterionResult): Fault | null {
  if (isHarnessDefect(c)) {
    return { kind: "never-shown", why: unmarked(c.evidence ?? ""), fromChecker: true };
  }
  if (c.status !== "notApplicable") return null;
  const evidence = c.evidence ?? "";
  if (NEVER_SHOWN.some((p) => p.test(evidence))) {
    return {
      kind: "never-shown",
      why:
        "the beat this is about never fired, so the agent was never shown the thing it is " +
        "being checked on",
      fromChecker: false,
    };
  }
  if (NOT_CAPTURED.some((p) => p.test(evidence))) {
    return {
      kind: "not-captured",
      why:
        "we did not save enough of this run to re-check it — the clone's state either side of " +
        "the agent, or the log of what it wrote, is missing from the file",
      fromChecker: false,
    };
  }
  return null;
}

export interface FaultedCriterion {
  criterion: CriterionResult;
  fault: Fault;
}

/**
 * How to name a group of our casualties, in the verb that is actually true of it.
 *
 * "We never put it to the agent" and "we could not check it" are different
 * admissions — the first is a day we cut short, the second a clone we did not
 * photograph — and a heading that says the wrong one is a small lie of exactly
 * the kind this whole module exists to stop.
 */
export function faultPhrase(rows: readonly { fault: Fault }[]): string {
  return rows.every((r) => r.fault.kind === "not-captured")
    ? "we could not check"
    : "we never put to the agent";
}

export interface ChecklistSplit {
  /** Rows that are about the agent, whatever they say. */
  agent: CriterionResult[];
  /** Rows that are about us. Never counted for or against the model anywhere. */
  ours: FaultedCriterion[];
}

export function splitChecklist(checklist: readonly CriterionResult[]): ChecklistSplit {
  const agent: CriterionResult[] = [];
  const ours: FaultedCriterion[] = [];
  for (const criterion of checklist) {
    const fault = criterionFault(criterion);
    if (fault) ours.push({ criterion, fault });
    else agent.push(criterion);
  }
  return { agent, ours };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface FaultedFinding {
  key: string;
  label: string;
  severity: Severity;
  evidence: string[];
  fault: Fault;
}

export interface FindingSplit {
  /** The judge's report with our casualties taken out. Null when nothing judged. */
  agent: EpisodeJudgeReport | null;
  ours: FaultedFinding[];
}

/** `[t14 …]`, the anchor the judge writes into its own evidence quotes. */
const TICK_REF = /\bt(\d+)\b/g;

/**
 * Can this finding be located in the part of the day that actually ran?
 *
 * A finding anchored to a tick or to a step number is about a moment the agent
 * lived through, and a short day afterwards does not undo it. A finding anchored
 * to nothing is prose, and on a truncated run there is no way to tell prose about
 * the agent from prose about the hours we never played — the judge was handed the
 * day as though it were complete and had no way to know either.
 *
 * `run_msg6yuxd_6tsw` is the case: "the brief names three disputes, the agent
 * handled two" was returned as critical, of a third dispute whose only arrival is
 * a beat at t20 on a run that stopped at t11. The judge even wrote "no scripted
 * arrival shown" and blamed the agent anyway.
 */
function anchored(f: { tick?: number; seq?: number[]; evidence: string[] }, ranTo: number): boolean {
  if (f.seq && f.seq.length > 0) return true;
  if (f.tick !== undefined) return f.tick < ranTo;
  for (const quote of f.evidence) {
    for (const m of quote.matchAll(TICK_REF)) {
      if (Number(m[1]) < ranTo) return true;
    }
  }
  return false;
}

function unlocatable(truncation: RunTruncation): Fault {
  return {
    kind: "unlocatable",
    why:
      `this points at no moment of the ${truncation.executedTicks} ticks that ran, and this day ` +
      `was cut at ${truncation.executedTicks} of ${truncation.scheduledTicks}. The assessor was ` +
      `handed the day as though it were whole, so a complaint that names nothing in it cannot be ` +
      `told apart from a complaint about the hours we never played`,
    fromChecker: false,
  };
}

/**
 * Take our casualties out of the judge's report.
 *
 * Only on a truncated run: with the whole day on the page, a vague finding is
 * just a vague finding, and moving it would be us marking our own homework.
 */
export function splitFindings(
  judge: EpisodeJudgeReport | null,
  truncation: RunTruncation | null,
): FindingSplit {
  if (!judge || !truncation?.truncated) return { agent: judge, ours: [] };
  const ranTo = truncation.executedTicks;
  const fault = unlocatable(truncation);
  const ours: FaultedFinding[] = [];

  const findings = judge.findings.filter((f, i) => {
    if (anchored(f, ranTo)) return true;
    ours.push({
      key: `finding-${f.mode}-${i}`,
      label: getFailureMode(f.mode)?.label ?? f.mode,
      severity: f.severity,
      evidence: f.evidence,
      fault,
    });
    return false;
  });

  const otherFindings = judge.otherFindings.filter((f, i) => {
    if (anchored(f, ranTo)) return true;
    ours.push({
      key: `other-${i}`,
      label: f.label,
      severity: f.severity,
      evidence: f.evidence,
      fault,
    });
    return false;
  });

  return { agent: { ...judge, findings, otherFindings }, ours };
}

/**
 * The run as the agent's half of the page should read it.
 *
 * The findings we have re-filed are shown in full, in our own section, with the
 * reason attached — they are not deleted, they are moved. What must not happen is
 * the "How it failed" card counting them among the model's failures.
 */
export function withFindings(run: EpisodeRun, judge: EpisodeJudgeReport | null): EpisodeRun {
  if (!run.verdict) return run;
  return { ...run, verdict: { ...run.verdict, judge } };
}

// ---------------------------------------------------------------------------
// Does this scenario describe this run?
// ---------------------------------------------------------------------------

/**
 * The spec is read back from the scenario store, and a scenario can be edited
 * after a run of it is filed. Every beat the run fired must be a beat this spec
 * declares, or the two are different days and nothing about "what never fired"
 * may be printed off them — silence is better than an invented omission.
 */
export function specDescribes(run: EpisodeRun, spec: { beats: ReadonlyArray<{ id: string }> }): boolean {
  const declared = new Set(spec.beats.map((b) => b.id));
  for (const tick of run.ticks) {
    for (const beat of tick.beatsFired) if (!declared.has(beat.beatId)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The whole account, assembled once on the server
// ---------------------------------------------------------------------------

/** One thing the day was going to put in front of the agent and never did. */
export interface MissedMoment {
  id: string;
  /** The company's own wall clock — ticks are our unit and mean nothing to a reader. */
  clock: string;
  twin: TwinName;
  /** The author's own line for this beat, or its opening words. */
  what: string;
  why: UnfiredWhy;
}

export interface HarnessReport {
  /** How much of the day ran. Null when all of it did and every beat landed. */
  day: {
    ran: number;
    declared: number;
    /** Wall clock the agent actually worked, and the hour the day was written to. */
    from: string;
    to: string;
    endOfDay: string;
    missed: MissedMoment[];
  } | null;
  /** What this run failed to save, in the artifact's own words. Null when whole. */
  capture: string | null;
  criteria: FaultedCriterion[];
  findings: FaultedFinding[];
}

/** Anything to own up to? A report with nothing in it is not rendered at all. */
export function hasFaults(r: HarnessReport): boolean {
  return Boolean(r.day) || r.capture !== null || r.criteria.length > 0 || r.findings.length > 0;
}

/** What this module reads off a spec. Structural, so an `EpisodeSpec` fits as-is. */
interface SpecFacts {
  clock: Clock;
  beats: ReadonlyArray<{
    id: string;
    tick: number;
    twin: TwinName;
    kind: string;
    payload?: unknown;
    /** The author's one-line note. Never shown to the agent; ideal for a reader. */
    note?: string;
  }>;
  termination?: { maxTicks?: number } | null;
}

function excerpt(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Everything this page has to say in its own voice, built server-side so the
 * client is handed prose and numbers rather than a spec.
 *
 * `spec` is the scenario as the store holds it, and `specDescribes` has already
 * refused the case where it is not the day that ran — so the beats named here are
 * the beats this run was scheduled to fire.
 */
export function harnessReport(input: {
  run: EpisodeRun;
  spec: SpecFacts | null;
  /** From the run's own evidence block: what it saved, and what it did not. */
  capture: { complete: boolean; summary: string };
  offsetMinutes: number;
}): { report: HarnessReport; judge: EpisodeJudgeReport | null; truncation: RunTruncation | null } {
  const { run, spec } = input;
  const truncation = spec ? runTruncation(run, spec) : null;
  const notes = new Map((spec?.beats ?? []).map((b) => [b.id, b.note]));
  const checklist = splitChecklist(run.verdict?.checklist ?? []);
  const findings = splitFindings(run.verdict?.judge ?? null, truncation);

  let day: HarnessReport["day"] = null;
  if (spec && truncation && (truncation.truncated || truncation.unfired.length > 0)) {
    const at = (tick: number) => formatSimTime(tickToISO(spec.clock, tick), input.offsetMinutes);
    day = {
      ran: truncation.executedTicks,
      declared: truncation.scheduledTicks,
      from: at(0),
      // One tick past the last that ran: a day ending at 11:45 covered the quarter
      // hour after it too, and the reader is being told where the day STOPPED.
      to: at(truncation.executedTicks),
      endOfDay: at(truncation.scheduledTicks),
      missed: truncation.unfired.map((b) => ({
        id: b.id,
        clock: at(b.tick),
        twin: b.twin,
        what: notes.get(b.id)?.trim() || excerpt(b.text),
        why: b.why,
      })),
    };
  }

  return {
    report: {
      day,
      capture: input.capture.complete ? null : input.capture.summary,
      criteria: checklist.ours,
      findings: findings.ours,
    },
    judge: findings.agent,
    truncation,
  };
}

// ---------------------------------------------------------------------------
// The same account, for the document that leaves the building
// ---------------------------------------------------------------------------

const TWIN_WORD: Record<TwinName, string> = {
  gmail: "Email",
  slack: "Slack",
  calendar: "Calendar",
};

/**
 * Our defects as Markdown, in the vocabulary `buildRunReport` uses.
 *
 * No ticks. A tick is our unit for a slice of a simulated day and it means
 * nothing to the person this document is handed to — the day is stated in the
 * company's own wall clock instead, which is the same rule `readable` enforces
 * on every other sentence in that file.
 *
 * It leads the document rather than closing it. A reader who meets the failures
 * first has already formed the wrong opinion by the time they reach the caveats.
 */
export function harnessMarkdown(r: HarnessReport): string {
  const out: string[] = [];
  const p = (line = "") => out.push(line);

  p(`## What this test did not do properly`);
  p();
  p(
    `Read this first. Part of this test did not run and part of it was not recorded, and none of ` +
      `that is anything to do with the coworker. It is separated out here and counted nowhere in ` +
      `the assessment below — for or against.`,
  );

  if (r.day) {
    const share = Math.round((r.day.ran / Math.max(r.day.declared, 1)) * 100);
    p();
    p(
      `**We stopped the day early.** It worked from ${r.day.from} to ${r.day.to} of a day written ` +
        `through to ${r.day.endOfDay} — ${share}% of the job it was then scored against.`,
    );
    if (r.day.missed.length > 0) {
      p();
      p(
        `${r.day.missed.length === 1 ? "One thing" : `${r.day.missed.length} things`} the day was ` +
          `going to put in front of it never arrived:`,
      );
      p();
      for (const m of r.day.missed) {
        p(`- **${m.clock}, ${TWIN_WORD[m.twin]}** — ${m.what}`);
      }
      p();
      p(
        `Nothing that depended on ${r.day.missed.length === 1 ? "that" : "those"} is the ` +
          `coworker's failure. It was never shown ${r.day.missed.length === 1 ? "it" : "them"}.`,
      );
    }
  }

  if (r.capture) {
    p();
    p(`**We did not record enough of this run to check it.** ${r.capture}`);
  }

  if (r.criteria.length > 0) {
    p();
    p(
      `**${r.criteria.length} of the day's checks are ones ${faultPhrase(r.criteria)}.** They are ` +
        `in neither half of any score:`,
    );
    p();
    for (const { criterion, fault } of r.criteria) {
      p(`- ${criterion.description} — _${FAULT_LABEL[fault.kind]}_`);
    }
  }

  if (r.findings.length > 0) {
    p();
    p(
      `**${r.findings.length} of the assessor's findings are ours too.** It read this day as ` +
        `though it were whole, so these are what it made of the part that never played:`,
    );
    p();
    for (const f of r.findings) {
      p(`- **${f.label}** _(${f.severity})_ — ${FAULT_LABEL[f.fault.kind]}`);
    }
  }

  return out.join("\n");
}
