import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentToolCalls,
  asVerdictOutcome,
  checklistScore,
  episodeTwins,
  runExecution,
  verdictOutcome,
  type AgentTrace,
  type CoverageSlice,
  type Criterion,
  type CriterionResult,
  type CriterionStatus,
  type EpisodeJudgeReport,
  type JudgeCoverage,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type Person,
  type RunCost,
  type RunStatus,
  type TickRecord,
  type TwinAuditRow,
  type TwinName,
} from "@sonata/core";
import {
  autonomy,
  escalationsFromTicks,
  JUDGE_SUFFIX,
  readJudgeReport,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writeJudgeReport,
  writtenFromTicks,
} from "@sonata/judge";
import { runSimulation } from "./simulated";

// Read side of the run artifacts the engine writes to data/runs. Every
// filesystem fact about results lives here — the pages and the API routes are
// thin wrappers — so the traversal guard and the tolerance for half-written
// files exist in exactly one place.
//
// Nothing here throws on a missing field. A run that is still going is written
// tick by tick and must render anyway, so an artifact is normalized into an
// `EpisodeRun` with empty collections rather than rejected.

const TRACE_SUFFIX = ".trace.json";

/** A run id is a filename base and it arrives from a URL — never trust it. */
const SAFE_RUN_ID = /^[\w.-]+$/;

export function runsDir(): string {
  return process.env.SONATA_RUNS_DIR ?? path.join(process.cwd(), "data", "runs");
}

function resolveArtifact(runId: string, suffix: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const dir = path.resolve(runsDir());
  const file = path.resolve(dir, `${runId}${suffix}`);
  // Belt and braces: even an id that passes the pattern must land inside the dir.
  return file.startsWith(dir + path.sep) ? file : null;
}

/**
 * Last file parsed, kept because rendering one run reads the same artifact three
 * times — the run, the trace embedded in it, and the spec for the brief — and a
 * run with its trace embedded is megabytes.
 *
 * Validated against mtime *and* size rather than trusted: the engine appends to
 * a live run while the dashboard is open, and a results page showing yesterday's
 * ticks would be a worse bug than parsing twice. One entry, because the reads
 * that repeat are always consecutive.
 */
let lastRead: { file: string; mtimeMs: number; size: number; value: unknown } | null = null;

function readJson(file: string): unknown {
  try {
    const { mtimeMs, size } = statSync(file);
    if (lastRead && lastRead.file === file && lastRead.mtimeMs === mtimeMs && lastRead.size === size) {
      return lastRead.value;
    }
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    lastRead = { file, mtimeMs, size, value };
    return value;
  } catch {
    return null; // absent, or being written right now
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "judging",
  "done",
  "failed",
  "aborted",
];

// ---------------------------------------------------------------------------
// Evidence. What the artifact can actually be asked.
// ---------------------------------------------------------------------------

// Every deterministic criterion is answered from two snapshots and an audit log.
// When those are missing the checkers say "nothing to check against" on each row
// individually, and a reader with eight rows in front of them has no way to tell
// a criterion the agent failed from a criterion nobody captured — so half the
// findings in a report read as facts about the model when they are facts about
// us. This block is the artifact stating, once and in words, what it holds. It is
// written on every run and derived for runs filed before it existed, so no reader
// ever has to infer it from an empty object.

/** One attached twin's evidence in a filed artifact. */
export interface TwinEvidence {
  twin: TwinName;
  /** State captured after seeding and before the agent's first tick. */
  before: boolean;
  /** State captured after the agent's last tick. */
  after: boolean;
  /** Audit rows saved for this twin. */
  auditRows: number;
  /** What the clone said when it would not answer, when that is why the rest is false. */
  note?: string;
}

export interface RunEvidence {
  /** Every twin the run attached. A criterion for a twin absent here was never checkable. */
  twins: TwinEvidence[];
  /** Wall-clock window the saved audit rows cover. Null when no row was saved. */
  auditWindow: { fromMs: number; toMs: number } | null;
  /** True only when every attached twin has both snapshots and a readable log. */
  complete: boolean;
  /** The sentence a report prints instead of an undecidable checklist. */
  summary: string;
}

/**
 * A run as this module hands it back: the artifact, plus what it can be asked.
 *
 * `evidence` is not optional here even though it is a recent field on disk —
 * every reader gets one, derived when the file predates it, because the whole
 * point is that no surface is allowed to render a checklist without being able
 * to say what was behind it.
 */
export interface SavedRun extends EpisodeRun {
  evidence: RunEvidence;
  /**
   * True when the stand-in tick loop wrote this file rather than the engine —
   * a demo of the dashboard, not a measurement of a model. See ./simulated.
   */
  simulated: boolean;
}

/** Stable order, so two artifacts of the same run read the same way. */
const TWIN_ORDER: readonly TwinName[] = ["gmail", "slack", "calendar"];

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * What this run can be asked, from what it saved.
 *
 * Pure, and shared by the writer and the reader on purpose: the block filed with
 * a fresh run and the block derived for a 2025 artifact have to mean the same
 * thing, or "complete" would quietly mean two things in one table.
 */
export function describeEvidence(input: {
  /** The twins the run attached — not the ones it happened to capture. */
  twins: readonly TwinName[];
  snapshots: EpisodeRun["snapshots"];
  audit: readonly TwinAuditRow[];
  /** Per twin, why capture failed. The clone's own words, when it gave any. */
  notes?: Partial<Record<TwinName, string>>;
  /**
   * False when nothing ever asked the clones for their state.
   *
   * A run played without live twins and a run whose twins went quiet file the
   * same empty map, and only the first is a fact about the harness — so the
   * writer says which it was rather than leaving a reader to guess. Absent means
   * "asked": a reader deriving this block from an old artifact cannot know
   * either way, and accusing a run of never looking is the same lie backwards.
   */
  observed?: boolean;
}): RunEvidence {
  const attached = TWIN_ORDER.filter((t) => input.twins.includes(t));
  const rows = input.twins.length === 0 ? [] : input.audit;
  const observed = input.observed !== false;
  const twins: TwinEvidence[] = attached.map((twin) => {
    const pair = input.snapshots[twin];
    const before = Boolean(pair?.before);
    const after = Boolean(pair?.after);
    // A blank pair with no reason beside it is the whole failure: it reads as a
    // clone the agent left untouched. When the caller gave no reason, state the
    // only one we can stand behind — which is at minimum "this file does not
    // hold that observation, and here is who was supposed to take it".
    const note = input.notes?.[twin] ?? (before && after ? undefined : whyBlank(twin, before, after, observed));
    return {
      twin,
      before,
      after,
      auditRows: rows.filter((r) => r.twin === twin).length,
      ...(note ? { note } : {}),
    };
  });

  const stamps = rows.map((r) => r.ts).filter((ts) => Number.isFinite(ts) && ts > 0);
  const auditWindow =
    stamps.length > 0 ? { fromMs: Math.min(...stamps), toMs: Math.max(...stamps) } : null;
  const missing = twins.filter((t) => !t.before || !t.after);
  const complete = observed && attached.length > 0 && missing.length === 0 && auditWindow !== null;

  return {
    twins,
    auditWindow,
    complete,
    summary: evidenceSummary(twins, auditWindow, attached, observed),
  };
}

/** The default reason a twin has no usable pair, when the caller offered none. */
function whyBlank(twin: TwinName, before: boolean, after: boolean, observed: boolean): string {
  if (!observed) return `nothing asked the ${twin} clone for its state during this run`;
  if (!before && !after) return `the ${twin} clone was asked at both ends of the day and neither snapshot came back`;
  if (!before) return `no opening snapshot of ${twin} came back, so the closing one has nothing to be diffed against`;
  return `no closing snapshot of ${twin} came back, so the opening one has nothing to be diffed against`;
}

function evidenceSummary(
  twins: TwinEvidence[],
  auditWindow: RunEvidence["auditWindow"],
  attached: readonly TwinName[],
  observed = true,
): string {
  if (attached.length === 0) {
    return (
      "No clone was attached to this run, so nothing objective was ever observable. Every " +
      "deterministic criterion below is undecidable, and that is a fact about the harness, not " +
      "about the agent."
    );
  }

  const missing = twins.filter((t) => !t.before || !t.after);
  if (missing.length === 0 && auditWindow) {
    const total = twins.reduce((n, t) => n + t.auditRows, 0);
    return (
      `Both snapshots were captured for ${attached.join(", ")}, with ${total} audit ` +
      `row${total === 1 ? "" : "s"} between ${clockTime(auditWindow.fromMs)} and ` +
      `${clockTime(auditWindow.toMs)}. Every deterministic criterion here can be re-checked from ` +
      "this file alone."
    );
  }

  // Nobody looked. Said first and said as ours, because the checklist under it is
  // about to say "nothing to check against" on every objective row, and a reader
  // who has not been told this banks all of them as findings about the agent.
  if (!observed && missing.length === attached.length) {
    return (
      `No clone was ever asked for its state during this run (${attached.join(", ")}), so nothing ` +
      "in this file was observed in a live twin. Every deterministic criterion below is " +
      "undecidable, and that is a fact about the harness, not about the agent."
    );
  }

  const sentences: string[] = [];
  if (missing.length === attached.length && missing.every((t) => !t.before && !t.after)) {
    // The common shape, and the one that misleads: nothing was captured at all,
    // so every objective row is going to say "nothing to check against" and a
    // reader will bank all of them as findings unless this says otherwise first.
    const why = missing.find((t) => t.note)?.note;
    sentences.push(
      `Nothing was captured from any attached clone (${attached.join(", ")})` +
        `${why ? ` — ${why}` : ""}, so no criterion below can be decided by comparing state.`,
    );
  } else if (missing.length > 0) {
    const phrases = missing.map(missingPhrase).join("; ");
    sentences.push(
      `${phrases.charAt(0).toUpperCase()}${phrases.slice(1)} — criteria for ${
        missing.length === 1 ? "that surface" : "those surfaces"
      } cannot be decided from this file.`,
    );
  }
  if (!auditWindow) {
    sentences.push(
      "No audit rows were saved, so a reply that really went out cannot be proved from this file.",
    );
  }
  return sentences.join(" ");
}

function missingPhrase(t: TwinEvidence): string {
  const which = !t.before && !t.after ? "neither snapshot" : !t.before ? "no before-snapshot" : "no after-snapshot";
  return `${which} was captured for ${t.twin}${t.note ? ` (${t.note})` : ""}`;
}

function normalizeEvidence(raw: unknown, run: {
  twins: readonly TwinName[];
  snapshots: EpisodeRun["snapshots"];
  audit: readonly TwinAuditRow[];
}): RunEvidence {
  const e = asRecord(raw);
  // Derived, not defaulted, for an artifact written before this block existed:
  // the snapshots and the log on disk are exactly the inputs `describeEvidence`
  // takes, so an old run answers the same question as a new one.
  if (!e) return describeEvidence(run);
  const twins = list<unknown>(e.twins).flatMap((row) => {
    const t = asRecord(row);
    const name = TWIN_ORDER.find((n) => n === t?.twin);
    if (!t || !name) return [];
    return [
      {
        twin: name,
        before: t.before === true,
        after: t.after === true,
        auditRows: num(t.auditRows, 0),
        ...(typeof t.note === "string" && t.note ? { note: t.note } : {}),
      } satisfies TwinEvidence,
    ];
  });
  const w = asRecord(e.auditWindow);
  const auditWindow = w ? { fromMs: num(w.fromMs, 0), toMs: num(w.toMs, 0) } : null;
  return {
    twins,
    auditWindow,
    complete: e.complete === true,
    summary: str(e.summary, evidenceSummary(twins, auditWindow, twins.map((t) => t.twin))),
  };
}

/**
 * The twins a saved run attached, for an artifact that did not record them.
 *
 * The spec's own twin set is the honest floor: a criterion names a twin, so a
 * twin the spec grades against is one the run was expected to attach. Reading it
 * off the snapshots instead would make an uncaptured surface disappear from the
 * evidence block, which is the exact silence this whole file is fixing.
 */
function attachedTwins(spec: EpisodeSpec | null, snapshots: EpisodeRun["snapshots"]): TwinName[] {
  const fromSpec = spec ? episodeTwins(spec) : [];
  const captured = TWIN_ORDER.filter((t) => snapshots[t]);
  return TWIN_ORDER.filter((t) => fromSpec.includes(t) || captured.includes(t));
}

function normalizeCost(raw: unknown): RunCost {
  const c = asRecord(raw);
  return {
    usd: num(c?.usd, 0),
    promptTokens: num(c?.promptTokens, 0),
    completionTokens: num(c?.completionTokens, 0),
    llmCalls: num(c?.llmCalls, 0),
  };
}

/** One `shown of total`, or null when the pair is absent or not a pair. */
function normalizeSlice(raw: unknown): CoverageSlice | null {
  const s = asRecord(raw);
  if (!s || typeof s.shown !== "number" || typeof s.total !== "number") return null;
  if (!Number.isFinite(s.shown) || !Number.isFinite(s.total)) return null;
  return { shown: s.shown, total: s.total };
}

/**
 * How much of the day the judge was shown, carried forward from the file.
 *
 * Undefined means the report predates the counting, and the results page says so
 * in those words. So this must return undefined ONLY for a report that really has
 * none: rebuilding the report field by field and forgetting this line is how
 * every judged run came to print "how much of this day the assessor read was not
 * recorded — re-judge the run to find out" over a report whose own `coverage`
 * said `complete: true`. That advice cost a model call and could never work,
 * because the next read stripped the answer again.
 *
 * The three headline slices are required by `JudgeCoverage`; a file missing any
 * of them is not a coverage record, and half of one would be worse than none.
 */
function normalizeCoverage(raw: unknown): JudgeCoverage | undefined {
  const c = asRecord(raw);
  if (!c) return undefined;
  const steps = normalizeSlice(c.steps);
  const timeline = normalizeSlice(c.timeline);
  const narration = normalizeSlice(c.narration);
  if (!steps || !timeline || !narration) return undefined;
  const finalState = normalizeSlice(c.finalState);
  const fraction = num(c.fraction, 0);
  return {
    steps,
    timeline,
    narration,
    ...(finalState ? { finalState } : {}),
    fraction,
    // Trusted from the file when it is there, derived when it is not: `complete`
    // is what the UI branches on, and defaulting it to false would republish the
    // "not recorded" note on a report that did record a whole day.
    complete: typeof c.complete === "boolean" ? c.complete : fraction >= 1,
  };
}

function normalizeJudge(raw: unknown, runId: string): EpisodeJudgeReport | null {
  const j = asRecord(raw);
  if (!j) return null;
  const coverage = normalizeCoverage(j.coverage);
  return {
    runId: str(j.runId, runId),
    judgedAt: num(j.judgedAt, 0),
    model: str(j.model, "unknown model"),
    ...(coverage ? { coverage } : {}),
    taskUnderstanding: str(j.taskUnderstanding, ""),
    autonomyScore: num(j.autonomyScore, 0),
    summary: str(j.summary, ""),
    findings: list(j.findings),
    otherFindings: list(j.otherFindings),
    answers: list(j.answers),
  };
}

const CRITERION_STATUSES: readonly CriterionStatus[] = ["passed", "failed", "notApplicable"];

/**
 * One criterion row, from an artifact of any age.
 *
 * `status` replaced a `passed` boolean, because a boolean forces a lie about a
 * criterion nothing could decide — `true` pays an idle agent, `false` accuses it
 * of a failure the run has no evidence for. Runs written before the change are
 * still the record, so the old field is mapped rather than dropped; a row with
 * neither is `notApplicable`, which takes no part in any number.
 */
function normalizeCriterion(raw: unknown): CriterionResult | null {
  const c = asRecord(raw);
  if (!c) return null;
  const status =
    CRITERION_STATUSES.find((s) => s === c.status) ??
    (typeof c.passed === "boolean" ? (c.passed ? "passed" : "failed") : "notApplicable");
  return {
    id: str(c.id, "unknown"),
    description: str(c.description, ""),
    twin: (c.twin ?? "any") as CriterionResult["twin"],
    kind: c.kind as CriterionResult["kind"],
    severity: c.severity === "must" ? "must" : "should",
    weight: num(c.weight, 1),
    status,
    ...(typeof c.evidence === "string" ? { evidence: c.evidence } : {}),
    ...(typeof c.tick === "number" ? { tick: c.tick } : {}),
  };
}

/**
 * Re-run today's checker over the artifact, when the artifact carries the spec.
 *
 * The rows on disk were written by whatever checker was current the day the run
 * ended, and the two-valued one could not say `notApplicable`: it wrote
 * `passed: false` on criteria nothing could settle ("names no beat ref", "no
 * calendar snapshot in this run") and `passed: true` on `judged` criteria no
 * checker decides at all. Mapping those booleans forward republishes both lies —
 * an accusation on the results page and weight in the score.
 *
 * The artifact holds the spec, the world, the beats' handles, both snapshots,
 * every tick AND — since `EpisodeRun.audit` — the log, which together are every
 * input `runChecklist` takes. With all of them the re-derivation sees exactly what
 * the original scoring saw, and this is a pure recomputation.
 *
 * THE LOG IS NOT OPTIONAL, and the sentence that used to sit here — "the worst a
 * missing log can do is leave a criterion unproven rather than invent a failure" —
 * was simply false. Gmail records a `send` with the NEW MESSAGE's id and puts the
 * thread it joined nowhere on the row, and the thread a beat creates during the
 * day is in neither snapshot, so without the log a reply that really went out
 * reads as "no reply landed" and two emails that reached Derek read as "nothing
 * was sent to derek.park@momentum.com". Both were observed, on a real run, against
 * an artifact whose own stored rows said `passed` and quoted the audit id.
 *
 * So when the log is absent — every artifact written before it was saved — this
 * refuses to publish a failure it cannot support: see `reconcile`.
 *
 * Returns null when the run predates embedded specs — then the stored rows are
 * the only record there is.
 */
function rederiveChecklist(
  spec: EpisodeSpec | null,
  run: { ticks: TickRecord[]; snapshots: EpisodeRun["snapshots"]; audit: TwinAuditRow[] },
): CriterionResult[] | null {
  const criteria = list<Criterion>(spec?.success?.checklist);
  if (!spec?.world || criteria.length === 0) return null;
  try {
    return runChecklist({
      criteria,
      world: spec.world,
      beats: spec.beats,
      refs: refsFromTicks(run.ticks),
      snapshots: run.snapshots,
      audit: run.audit,
      escalations: escalationsFromTicks(run.ticks),
      written: writtenFromTicks(run.ticks),
      agentActed: agentToolCalls(run.ticks) > 0,
      tickOf: tickIndexer(run.ticks),
    }).results;
  } catch {
    // A malformed spec must not 500 the page it is being read for.
    return null;
  }
}

/**
 * Today's rows, except where today's checker was reading less than the writer did.
 *
 * Only ever applied to an artifact with NO saved audit log, which means every run
 * from before it was persisted. Those runs were scored by a checker that could
 * read the twins' logs; this process cannot, and the gap is not symmetric — the
 * providers prove a positive FROM the log, so what re-derivation loses is
 * evidence for passes, and every row it loses turns into a failure.
 *
 * A re-derived `failed` over a stored `passed` is therefore not a correction. It
 * is this reader knowing less, and the only honest row is `notApplicable`: not the
 * old pass, which might have been one of the two-valued checker's lies, and not
 * the new failure, which rests on evidence that was thrown away. The run comes out
 * inconclusive, which is what a run nobody can re-check now actually is.
 *
 * Every other transition is a real correction and passes through untouched — a
 * stored `passed` becoming `notApplicable` is the two-valued fix this function
 * exists alongside, and a stored `failed` can go anywhere, since a failure was
 * never the thing the missing log was holding up.
 */
/**
 * The checklist any reader of this artifact should see, from the raw record.
 *
 * One function, because the read path and the re-judge WRITE path both re-derive,
 * and the write path persists what it derives. If the two ever disagreed, opening
 * a run would show one checklist and re-judging it would bake in another.
 */
function checklistFrom(raw: Record<string, unknown>): CriterionResult[] | null {
  const ticks = list<TickRecord>(raw.ticks);
  const snapshots = (asRecord(raw.snapshots) ?? {}) as EpisodeRun["snapshots"];
  const spec = (asRecord(raw.spec) as unknown as EpisodeSpec | null) ?? null;
  const audit = list<TwinAuditRow>(raw.audit);
  const derived = rederiveChecklist(spec, { ticks, snapshots, audit });
  if (!derived) return null;
  if (audit.length > 0) return derived;
  const stored = storedChecklist(raw);
  if (stored.length === 0) return derived;
  return reconcile(derived, stored, evidenceOf(raw, spec, snapshots, audit).summary);
}

function evidenceOf(
  raw: Record<string, unknown>,
  spec: EpisodeSpec | null,
  snapshots: EpisodeRun["snapshots"],
  audit: TwinAuditRow[],
): RunEvidence {
  return normalizeEvidence(raw.evidence, {
    twins: attachedTwins(spec, snapshots),
    snapshots,
    audit,
  });
}

function storedChecklist(raw: Record<string, unknown>): CriterionResult[] {
  return list<unknown>(asRecord(raw.verdict)?.checklist).flatMap((row) => {
    const c = normalizeCriterion(row);
    return c ? [c] : [];
  });
}

function reconcile(
  fresh: CriterionResult[],
  stored: CriterionResult[],
  why: string,
): CriterionResult[] {
  const before = new Map(stored.map((c) => [c.id, c]));
  return fresh.map((c) => {
    const was = before.get(c.id);
    if (!was || was.status !== "passed" || c.status !== "failed") return c;
    return {
      ...c,
      status: "notApplicable" as const,
      // The reason, not just the fact. "The log was not saved" leaves a reader to
      // guess whether the clone fell over or nothing was ever attached, and those
      // are different sentences in a published report.
      evidence:
        `${why} Today's checker is therefore reading less than the one that scored this run, ` +
        `which recorded: "${was.evidence ?? "passed"}". Re-checking now reports ` +
        `"${c.evidence ?? "failed"}", and that failure rests on the missing evidence rather than ` +
        `on anything in the artifact. Neither can be published, so this criterion is left undecided`,
    };
  });
}

/**
 * Derive the verdict's numbers rather than trusting the ones on disk.
 *
 * All three are pure functions of the checklist and the ticks, and the artifact
 * is the only input either of them needs — so deriving costs microseconds and
 * buys the one property this product cannot do without: the figure a page prints
 * is the figure today's code computes. A scalar written by a formula since
 * replaced can no longer outlive it, and `autonomy` in particular stays the
 * headline @sonata/judge defines it to be, not whatever a writer once cached.
 *
 * A verdict with no checklist at all has nothing to derive from — an artifact
 * half-written, or one whose criteria were never persisted — so there the stored
 * scalars are all there is, and they stand.
 */
function normalizeVerdict(
  raw: unknown,
  runId: string,
  ticks: TickRecord[],
  fresh: CriterionResult[] | null,
): EpisodeVerdict | null {
  const v = asRecord(raw);
  if (!v) return null;
  const checklist =
    fresh ??
    list<unknown>(v.checklist).flatMap((row) => {
      const c = normalizeCriterion(row);
      return c ? [c] : [];
    });
  const judge = normalizeJudge(v.judge, runId);
  const derivable = checklist.length > 0;
  return {
    outcome: derivable ? verdictOutcome(checklist) : (asVerdictOutcome(v.outcome) ?? verdictOutcome(checklist)),
    score: derivable ? checklistScore(checklist) : num(v.score, 0),
    autonomy: derivable ? autonomy(checklist, ticks).score : num(v.autonomy, 0),
    checklist,
    judge,
    cost: normalizeCost(v.cost),
  };
}

/**
 * The brief, when the writer embedded the spec. `EpisodeRun` only carries a
 * `specId`, so this is best-effort: the run detail page hides the sections it
 * cannot fill instead of inventing a task.
 */
export interface RunBrief {
  task?: string;
  story?: string;
  judgeQuestions: string[];
  /** Minutes east of UTC, from the spec's clock — the day's own wall clock. */
  offsetMinutes: number;
  /**
   * `Person.id` → name, from the run's own cast. Director events name people by
   * id, and a timeline row reading "dana answered" is the seam between the data
   * model and the story showing through.
   */
  people: Record<string, string>;
}

function castNames(spec: EpisodeSpec | null): Record<string, string> {
  const people: Record<string, string> = {};
  for (const person of list<Person>(spec?.world?.cast)) {
    if (typeof person?.id === "string" && typeof person.name === "string") {
      people[person.id] = person.name;
    }
  }
  return people;
}

function normalizeRun(raw: unknown, fallbackId: string): SavedRun | null {
  const r = asRecord(raw);
  if (!r) return null;
  const runId = str(r.runId, fallbackId);
  const ticks = list<TickRecord>(r.ticks);
  const snapshots = (asRecord(r.snapshots) ?? {}) as EpisodeRun["snapshots"];
  const spec = (asRecord(r.spec) as unknown as EpisodeSpec | null) ?? null;
  const audit = list<TwinAuditRow>(r.audit);
  const saved = normalizeVerdict(r.verdict, runId, ticks, checklistFrom(r));
  const status = RUN_STATUSES.find((s) => s === r.status);
  // Asked here, where the raw verdict is still in hand, because `cost.llmCalls`
  // is one of its inputs and the next line is about to throw the verdict away.
  const simulation = status
    ? runSimulation({ status, ticks, audit, snapshots, verdict: saved })
    : { simulated: false };
  // A verdict is only read back for a run that was in a state to have earned
  // one. Artifacts written before scoring learned to refuse still carry numbers
  // farmed off negative criteria by agents that never moved, and this page is
  // where those numbers would re-enter the product.
  //
  // A fabricated run is refused on the same grounds and by the same line: it has
  // a checklist and a score, and both are readings of a coin flip. Dropping the
  // verdict here is what keeps it out of every average downstream — `summarizeRun`
  // has no score to publish, and `reconcileRunRows` writes the null through to the
  // row Home reads — without a second notion of "excluded" existing anywhere.
  const verdict =
    status && (simulation.simulated || !runExecution({ status, ticks }).executed) ? null : saved;
  return {
    runId,
    specId: str(r.specId, "unknown"),
    specTitle: str(r.specTitle, str(r.specId, "Untitled scenario")),
    model: str(r.model, "unknown model"),
    // A file with no status but a verdict has been through scoring; without one
    // it is most likely still being appended to.
    status: status ?? (saved ? "done" : "running"),
    startedAt: num(r.startedAt, 0),
    endedAt: typeof r.endedAt === "number" ? r.endedAt : null,
    ticks,
    snapshots,
    ...(audit.length > 0 ? { audit } : {}),
    evidence: evidenceOf(r, spec, snapshots, audit),
    simulated: simulation.simulated,
    verdict,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  };
}

/** Newest first. Ids are timestamps, so a lexical sort is a chronological one. */
export function listRuns(): SavedRun[] {
  let names: string[];
  try {
    names = readdirSync(runsDir());
  } catch {
    return []; // no runs yet — the empty state teaches from here
  }

  return names
    // The trace and the judge report are siblings, not runs. Both end `.json`,
    // so listing them would render two garbage rows for every real one.
    .filter((n) => n.endsWith(".json") && !n.endsWith(TRACE_SUFFIX) && !n.endsWith(JUDGE_SUFFIX))
    .map((n) => n.slice(0, -".json".length))
    .flatMap((runId) => {
      const run = readRun(runId);
      return run ? [run] : [];
    })
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.runId.localeCompare(a.runId));
}

export function readRun(runId: string): SavedRun | null {
  const file = resolveArtifact(runId, ".json");
  if (!file) return null;
  const run = normalizeRun(readJson(file), runId);
  if (!run) return null;

  // The judge report is its own artifact — that is what lets `sonata judge` read
  // a finished day back cheaply. The copy embedded in the verdict is a
  // convenience, so when the run file has none the sibling is the record.
  if (run.verdict && !run.verdict.judge) {
    run.verdict.judge = readJudgeReport(runsDir(), runId);
  }
  return run;
}

/**
 * The trace, which the engine may embed or write beside the run. It is the only
 * artifact that carries verbatim provider bodies, so it is read on demand and
 * never as part of the list.
 */
export function readTrace(runId: string): AgentTrace | null {
  const sibling = resolveArtifact(runId, TRACE_SUFFIX);
  const embedded = resolveArtifact(runId, ".json");
  const raw =
    (sibling ? asRecord(readJson(sibling)) : null) ??
    (embedded ? asRecord(asRecord(readJson(embedded))?.trace) : null);
  if (!raw) return null;
  return {
    runId: str(raw.runId, runId),
    llmCalls: list(raw.llmCalls),
    toolCalls: list(raw.toolCalls),
    ...(typeof raw.agentSummary === "string" ? { agentSummary: raw.agentSummary } : {}),
  };
}

/**
 * The whole spec the run was written with, or null on an artifact that predates
 * embedded specs.
 *
 * SERVER ONLY, and deliberately not folded into `RunBrief`: a spec carries the
 * world, the cast and every beat, and `RunBrief` is handed to a client component
 * — putting it there would ship a scenario down the wire to render a heading.
 * The judge is the one caller that genuinely needs all of it, because the clock
 * and the beats are what date the day and say how much of it actually fired.
 */
export function readSpec(runId: string): EpisodeSpec | null {
  const file = resolveArtifact(runId, ".json");
  if (!file) return null;
  return (asRecord(asRecord(readJson(file))?.spec) as unknown as EpisodeSpec | null) ?? null;
}

export function readBrief(runId: string): RunBrief {
  const spec = readSpec(runId);
  const startISO = spec?.clock?.startISO;
  return {
    ...(typeof spec?.task === "string" ? { task: spec.task } : {}),
    ...(typeof spec?.story === "string" ? { story: spec.story } : {}),
    judgeQuestions: list<string>(spec?.success?.judgeQuestions),
    offsetMinutes: startISO ? safeOffsetMinutes(startISO) : 0,
    people: castNames(spec),
  };
}

export interface EvidenceRepair {
  runId: string;
  evidence: RunEvidence;
  /** True when the file changed. False for a run that already stated its evidence. */
  written: boolean;
}

/**
 * Write the evidence block onto artifacts filed before it existed.
 *
 * THIS DOES NOT RECOVER EVIDENCE, and it cannot: a snapshot is a picture of a
 * clone at a moment that is gone, and the trace beside a run carries the audit
 * row *ids* a tool call touched but never the rows themselves — no `ts`, no
 * `endpoint`, no summary — so there is nothing to rebuild a log out of. What it
 * recovers is the artifact's ability to SAY so, which is the half that was
 * costing readers a wrong conclusion: an old run comes out of this able to
 * report "neither snapshot was captured for gmail" instead of quietly handing a
 * checker an empty object and letting eight rows of "nothing to check against"
 * read as eight findings about the model.
 *
 * Idempotent, and it edits the raw record so a field this module does not model
 * is never the price of running it.
 */
export function repairEvidence(runIds?: readonly string[]): EvidenceRepair[] {
  const ids = runIds ?? listRuns().map((r) => r.runId);
  const out: EvidenceRepair[] = [];
  for (const runId of ids) {
    const file = resolveArtifact(runId, ".json");
    if (!file) continue;
    const raw = asRecord(readJson(file));
    if (!raw) continue;
    const snapshots = (asRecord(raw.snapshots) ?? {}) as EpisodeRun["snapshots"];
    const spec = (asRecord(raw.spec) as unknown as EpisodeSpec | null) ?? null;
    const evidence = evidenceOf(raw, spec, snapshots, list<TwinAuditRow>(raw.audit));
    if (asRecord(raw.evidence)) {
      out.push({ runId, evidence, written: false });
      continue;
    }
    raw.evidence = evidence;
    try {
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      out.push({ runId, evidence, written: true });
    } catch (err) {
      console.warn(`[sonata] could not repair the evidence block of ${runId}:`, (err as Error).message);
    }
  }
  return out;
}

/** Every artifact the stand-in wrote, newest first. */
export function listSimulatedRuns(): SavedRun[] {
  return listRuns().filter((run) => run.simulated);
}

/**
 * Delete one run's files: the artifact, its trace and its judge report.
 *
 * Only ever called by `sonata prune`, and deliberately not by anything the
 * dashboard can reach. A fabricated run is evidence of how the product misled
 * its owner, and evidence is not something a page gets to tidy away — the owner
 * asks for this at a terminal, having read the list, or it does not happen.
 *
 * Returns the files that were actually removed, so the caller can report the
 * deletion rather than assert it.
 */
export function deleteRunArtifacts(runId: string): string[] {
  const removed: string[] = [];
  for (const suffix of [".json", TRACE_SUFFIX, JUDGE_SUFFIX]) {
    const file = resolveArtifact(runId, suffix);
    if (!file || !existsSync(file)) continue;
    rmSync(file);
    removed.push(file);
  }
  // The one-entry parse cache may still be holding a file that no longer exists.
  if (removed.length > 0) lastRead = null;
  return removed;
}

/** `offsetMinutes` throws on an offsetless string; a bad spec must not 500 a page. */
function safeOffsetMinutes(iso: string): number {
  const m = /(?:Z|([+-])(\d{2}):?(\d{2}))$/.exec(iso);
  if (!m) return 0;
  if (!m[1]) return 0;
  const magnitude = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -magnitude : magnitude;
}

/**
 * Write a fresh judge report back onto a saved run.
 *
 * Two files, because the report is its own artifact: `<runId>.judge.json` beside
 * the run — which is what `sonata judge <runId> --model X` overwrites when a
 * finished day is read back by a different model, with no episode re-run — and a
 * copy embedded in the verdict so one read of the run file renders the page.
 *
 * The run file is a read-modify-write on the *raw* record, not the normalized
 * one: the engine owns it and may have written fields this module does not
 * model, and a re-judge must never be the thing that drops them.
 */
export function updateRunJudge(runId: string, report: EpisodeJudgeReport): EpisodeVerdict | null {
  const file = resolveArtifact(runId, ".json");
  if (!file) return null;
  const raw = asRecord(readJson(file));
  if (!raw) return null;

  // The separate artifact first: it is the record, and a run file that failed to
  // write must not also lose the judge pass that was just paid for.
  try {
    writeJudgeReport(runsDir(), { ...report, runId });
  } catch (err) {
    console.warn(`[sonata] could not write the judge artifact for ${runId}:`, (err as Error).message);
  }

  const ticks = list<TickRecord>(raw.ticks);
  const snapshots = (asRecord(raw.snapshots) ?? {}) as EpisodeRun["snapshots"];
  const spec = (asRecord(raw.spec) as unknown as EpisodeSpec | null) ?? null;
  const verdict = asRecord(raw.verdict) ?? {};
  // The same checklist the pages will read — today's checker over the artifact,
  // falling back to the stored rows normalized. Not the raw rows: the scorers
  // read `status`, and an older row carrying only `passed` would otherwise weigh
  // nothing and write a zero over a real headline.
  const checklist = checklistFrom(raw) ?? storedChecklist(raw);
  verdict.judge = report;
  // Autonomy is derived from the checklist and the shape of the day, not from the
  // findings, so re-judging deliberately leaves it where it was. Recomputed
  // anyway, because an older artifact may carry a number from a formula since
  // replaced and the two pages that read this file have to say the same thing.
  verdict.autonomy = autonomy(checklist, ticks).score;
  raw.verdict = verdict;

  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return normalizeVerdict(verdict, runId, ticks, checklist);
}
