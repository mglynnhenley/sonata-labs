import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EpisodeJudgeReport } from "@sonata/core";
import { runsDir } from "../../../app/results/_lib/artifacts";
import type { JudgeSpend } from "../../../app/api/results/_lib/judgeAttempt";

export class AssessmentBusyError extends Error {
  constructor() { super("An assessment is already running for this day."); }
}

export interface Assessment {
  id: string;
  runId: string;
  ownerPid?: number;
  model: string;
  runner: "inspect" | "legacy";
  startedAt: number;
  endedAt: number | null;
  status: "judging" | "judged" | "failed";
  automatic: boolean;
  report: EpisodeJudgeReport | null;
  spend: JudgeSpend | null;
  error: string | null;
  log: string | null;
  provenance: Record<string, unknown>;
}

export function assessmentDir(runId: string, id?: string): string {
  if (!/^[\w-]+$/.test(runId) || (id !== undefined && !/^[\w-]+$/.test(id))) {
    throw new Error("Invalid assessment identifier.");
  }
  return path.resolve(runsDir(), "assessments", runId, ...(id ? [id] : []));
}

export function writeAssessment(record: Assessment): void {
  const dir = assessmentDir(record.runId, record.id);
  mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n");
  renameSync(temporary, path.join(dir, "assessment.json"));
}

export function readAssessment(runId: string, id: string): Assessment | null {
  const file = path.join(assessmentDir(runId, id), "assessment.json");
  if (!existsSync(file)) return null;
  const record = JSON.parse(readFileSync(file, "utf8")) as Assessment;
  if (record.runId !== runId || record.id !== id) throw new Error("Assessment provenance does not match its location.");
  if (record.status === "judging" && record.ownerPid) {
    let disappeared = false;
    try { process.kill(record.ownerPid, 0); }
    catch (error) { disappeared = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (disappeared || Date.now() - record.startedAt > 9 * 60_000) {
      return { ...record, status: "failed", error: "The process running this assessment stopped before saving a report.",
        log: record.log ?? readdirSync(path.dirname(file)).find(name => name.endsWith(".eval")) ?? null };
    }
  }
  return record;
}

export function listAssessments(runId: string): Assessment[] {
  const dir = assessmentDir(runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => readAssessment(runId, e.name)).filter((a): a is Assessment => a !== null)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Preserve the latest old report before the first new assessment replaces its display copy. */
export function preserveLegacyReport(runId: string, report: EpisodeJudgeReport | null): void {
  if (!report) return;
  const id = `legacy-${evidenceHash(report).slice(0, 24)}`;
  if (listAssessments(runId).some(a => a.report?.judgedAt === report.judgedAt && a.report.model === report.model)) return;
  writeAssessment({ id, runId, model: report.model, runner: "legacy", startedAt: report.judgedAt,
    endedAt: report.judgedAt, status: "judged", automatic: false, report, spend: null,
    error: null, log: null, provenance: { note: "Preserved historical report; original prompt and pass cost were not recorded here." } });
}
