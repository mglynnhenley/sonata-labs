import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentToolCalls,
  checklistScore,
  runExecution,
  verdictOutcome,
  type AgentTrace,
  type Criterion,
  type CriterionResult,
  type CriterionStatus,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type Person,
  type RunCost,
  type RunStatus,
  type TickRecord,
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

function normalizeCost(raw: unknown): RunCost {
  const c = asRecord(raw);
  return {
    usd: num(c?.usd, 0),
    promptTokens: num(c?.promptTokens, 0),
    completionTokens: num(c?.completionTokens, 0),
    llmCalls: num(c?.llmCalls, 0),
  };
}

function normalizeJudge(raw: unknown, runId: string): EpisodeJudgeReport | null {
  const j = asRecord(raw);
  if (!j) return null;
  return {
    runId: str(j.runId, runId),
    judgedAt: num(j.judgedAt, 0),
    model: str(j.model, "unknown model"),
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
 * The artifact holds the spec, the world, the beats' handles, both snapshots and
 * every tick, which is all `runChecklist` reads bar the audit log; the providers
 * fall back to snapshot deltas without it, so the worst a missing log can do is
 * leave a criterion unproven rather than invent a failure.
 *
 * Returns null when the run predates embedded specs — then the stored rows are
 * the only record there is.
 */
function rederiveChecklist(
  spec: EpisodeSpec | null,
  run: { ticks: TickRecord[]; snapshots: EpisodeRun["snapshots"] },
): CriterionResult[] | null {
  const criteria = list<Criterion>(spec?.success?.checklist);
  if (!spec?.world || criteria.length === 0) return null;
  try {
    return runChecklist({
      criteria,
      world: spec.world,
      refs: refsFromTicks(run.ticks),
      snapshots: run.snapshots,
      audit: [],
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
    outcome: derivable
      ? verdictOutcome(checklist)
      : v.outcome === "pass" || v.outcome === "partial" || v.outcome === "fail"
        ? v.outcome
        : verdictOutcome(checklist),
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

function normalizeRun(raw: unknown, fallbackId: string): EpisodeRun | null {
  const r = asRecord(raw);
  if (!r) return null;
  const runId = str(r.runId, fallbackId);
  const ticks = list<TickRecord>(r.ticks);
  const snapshots = (asRecord(r.snapshots) ?? {}) as EpisodeRun["snapshots"];
  const spec = (asRecord(r.spec) as unknown as EpisodeSpec | null) ?? null;
  const saved = normalizeVerdict(
    r.verdict,
    runId,
    ticks,
    rederiveChecklist(spec, { ticks, snapshots }),
  );
  const status = RUN_STATUSES.find((s) => s === r.status);
  // A verdict is only read back for a run that was in a state to have earned
  // one. Artifacts written before scoring learned to refuse still carry numbers
  // farmed off negative criteria by agents that never moved, and this page is
  // where those numbers would re-enter the product.
  const verdict =
    status && !runExecution({ status, ticks }).executed ? null : saved;
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
    verdict,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  };
}

/** Newest first. Ids are timestamps, so a lexical sort is a chronological one. */
export function listRuns(): EpisodeRun[] {
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

export function readRun(runId: string): EpisodeRun | null {
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

export function readBrief(runId: string): RunBrief {
  const file = resolveArtifact(runId, ".json");
  const spec = file ? (asRecord(asRecord(readJson(file))?.spec) as unknown as EpisodeSpec | null) : null;
  const startISO = spec?.clock?.startISO;
  return {
    ...(typeof spec?.task === "string" ? { task: spec.task } : {}),
    ...(typeof spec?.story === "string" ? { story: spec.story } : {}),
    judgeQuestions: list<string>(spec?.success?.judgeQuestions),
    offsetMinutes: startISO ? safeOffsetMinutes(startISO) : 0,
    people: castNames(spec),
  };
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
  const fresh = rederiveChecklist(spec, { ticks, snapshots });
  const checklist =
    fresh ??
    list<unknown>(verdict.checklist).flatMap((row) => {
      const c = normalizeCriterion(row);
      return c ? [c] : [];
    });
  verdict.judge = report;
  // Autonomy is derived from the checklist and the shape of the day, not from the
  // findings, so re-judging deliberately leaves it where it was. Recomputed
  // anyway, because an older artifact may carry a number from a formula since
  // replaced and the two pages that read this file have to say the same thing.
  verdict.autonomy = autonomy(checklist, ticks).score;
  raw.verdict = verdict;

  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return normalizeVerdict(verdict, runId, ticks, fresh);
}
