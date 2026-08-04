import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  autonomyScore,
  checklistScore,
  verdictOutcome,
  type AgentTrace,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type EpisodeSpec,
  type EpisodeVerdict,
  type Person,
  type RunCost,
  type RunStatus,
  type TickRecord,
} from "@sonata/core";

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

/**
 * Recompute anything the writer left out rather than showing a zero. The score
 * helpers in @sonata/core are pure and derive from the checklist, so a verdict
 * written before the judge ran still shows the right numbers — and a re-judge
 * that changes the findings changes autonomy the same way it did the first time.
 */
function normalizeVerdict(raw: unknown, runId: string): EpisodeVerdict | null {
  const v = asRecord(raw);
  if (!v) return null;
  const checklist = list<CriterionResult>(v.checklist);
  const judge = normalizeJudge(v.judge, runId);
  return {
    outcome:
      v.outcome === "pass" || v.outcome === "partial" || v.outcome === "fail"
        ? v.outcome
        : verdictOutcome(checklist),
    score: num(v.score, checklistScore(checklist)),
    autonomy: num(v.autonomy, autonomyScore(checklist, judge?.findings ?? [])),
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
  const verdict = normalizeVerdict(r.verdict, runId);
  const status = RUN_STATUSES.find((s) => s === r.status);
  return {
    runId,
    specId: str(r.specId, "unknown"),
    specTitle: str(r.specTitle, str(r.specId, "Untitled scenario")),
    model: str(r.model, "unknown model"),
    // A file with no status but a verdict has been through scoring; without one
    // it is most likely still being appended to.
    status: status ?? (verdict ? "done" : "running"),
    startedAt: num(r.startedAt, 0),
    endedAt: typeof r.endedAt === "number" ? r.endedAt : null,
    ticks: list<TickRecord>(r.ticks),
    snapshots: (asRecord(r.snapshots) ?? {}) as EpisodeRun["snapshots"],
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
    .filter((n) => n.endsWith(".json") && !n.endsWith(TRACE_SUFFIX))
    .map((n) => n.slice(0, -".json".length))
    .flatMap((runId) => {
      const run = readRun(runId);
      return run ? [run] : [];
    })
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.runId.localeCompare(a.runId));
}

export function readRun(runId: string): EpisodeRun | null {
  const file = resolveArtifact(runId, ".json");
  return file ? normalizeRun(readJson(file), runId) : null;
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
 * Read-modify-write on the *raw* record, not the normalized one: the engine owns
 * this file and may have written fields this module does not model, and a
 * re-judge must never be the thing that drops them.
 */
export function updateRunJudge(runId: string, report: EpisodeJudgeReport): EpisodeVerdict | null {
  const file = resolveArtifact(runId, ".json");
  if (!file) return null;
  const raw = asRecord(readJson(file));
  if (!raw) return null;

  const verdict = asRecord(raw.verdict) ?? {};
  const checklist = list<CriterionResult>(verdict.checklist);
  verdict.judge = report;
  // Autonomy is derived, so it has to move with the findings that produced it.
  verdict.autonomy = autonomyScore(checklist, report.findings);
  raw.verdict = verdict;

  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return normalizeVerdict(verdict, runId);
}
