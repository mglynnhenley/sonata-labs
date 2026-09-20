import type { BenchmarkCriterion, BenchmarkFamilyResult, BenchmarkReport } from "@sonata/core";

export interface AggregateBenchmarkInput {
  caseId: "W01" | "E01";
  criteria: BenchmarkCriterion[];
  incidents: Array<Record<string, unknown>>;
  limitations: string[];
  completedTicks: number;
  /** The original declared horizon, never a smoke-run tick cap. */
  plannedTicks: number;
  completion: "complete" | "partial" | "failed";
  snapshots: { before: string; after: string };
  completedThrough: string | null;
}

function mean(values: Array<number | null>): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null;
}

function criterionScore(criterion: BenchmarkCriterion): number | null {
  return mean(criterion.units.map((unit) => typeof unit.score === "number" ? unit.score : null));
}

function unmeasured(criterion: BenchmarkCriterion): boolean {
  return criterion.units.length === 0 || criterion.units.some((unit) => unit.score === "U");
}

function groupedMean(criteria: BenchmarkCriterion[]): number | null {
  const groups = [...new Set(criteria.map((criterion) => criterion.group ?? criterion.id))];
  return mean(groups.map((group) => mean(criteria.filter((criterion) =>
    (criterion.group ?? criterion.id) === group).map(criterionScore))));
}

function familyScore(id: string, criteria: BenchmarkCriterion[]): BenchmarkFamilyResult {
  const observedScore = groupedMean(criteria);
  return { id, criteria: criteria.map((criterion) => criterion.id), observedScore,
    score: criteria.some(unmeasured) ? null : observedScore };
}

const percent = (value: number | null): number | null => value === null ? null : value * 50;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Recompute saved scores from validated marks; malformed evidence is never a displayed success. */
export function normalizeBenchmarkReport(value: unknown): BenchmarkReport | null {
  if (!record(value) || value.kind !== "continuity" || value.version !== 1 ||
      (value.caseId !== "W01" && value.caseId !== "E01") ||
      !Array.isArray(value.criteria) || !Array.isArray(value.incidents) || !value.incidents.every(record) ||
      !strings(value.limitations) || typeof value.completedTicks !== "number" || typeof value.plannedTicks !== "number" ||
      (value.completion !== "complete" && value.completion !== "partial" && value.completion !== "failed") ||
      (value.completedThrough !== null && typeof value.completedThrough !== "string") ||
      !record(value.snapshots) || typeof value.snapshots.before !== "string" || typeof value.snapshots.after !== "string") return null;
  for (const criterion of value.criteria) {
    if (!record(criterion) || typeof criterion.id !== "string" || typeof criterion.family !== "string" ||
        (criterion.group !== undefined && (typeof criterion.group !== "string" || !criterion.group.trim())) ||
        (criterion.reporting !== undefined && typeof criterion.reporting !== "boolean") || !Array.isArray(criterion.units)) return null;
    for (const unit of criterion.units) {
      if (!record(unit) || typeof unit.id !== "string" || typeof unit.reason !== "string" || !strings(unit.evidence) ||
          ![0, 1, 2, "U", "N/A"].includes(unit.score as number | string)) return null;
    }
  }
  try {
    return aggregateBenchmark({ caseId: value.caseId, criteria: value.criteria as BenchmarkCriterion[],
      incidents: value.incidents, limitations: value.limitations, completedTicks: value.completedTicks,
      plannedTicks: value.plannedTicks, completion: value.completion, completedThrough: value.completedThrough,
      snapshots: { before: value.snapshots.before, after: value.snapshots.after } });
  } catch {
    return null;
  }
}

/** Pure aggregation of persisted domain marks. Never reads live twins or calls a model. */
export function aggregateBenchmark(input: AggregateBenchmarkInput): BenchmarkReport {
  if (!["complete", "partial", "failed"].includes(input.completion)) throw new Error("benchmark completion must identify complete, partial or failed capture");
  if (!Number.isInteger(input.plannedTicks) || input.plannedTicks <= 0 ||
      !Number.isInteger(input.completedTicks) || input.completedTicks < 0 || input.completedTicks > input.plannedTicks) {
    throw new RangeError("benchmark ticks must be integers: 0 <= completedTicks <= plannedTicks, plannedTicks > 0");
  }
  if (input.completedThrough !== null && !Number.isFinite(Date.parse(input.completedThrough))) {
    throw new RangeError("benchmark completedThrough must be a date or null");
  }
  const criteria = structuredClone(input.criteria);
  const limitations = [...input.limitations];
  const criterionIds = new Set<string>();
  for (const criterion of criteria) {
    if (!criterion.id || !criterion.family || criterionIds.has(criterion.id)) throw new Error("benchmark criteria require unique IDs and a family");
    if (criterion.group !== undefined && (typeof criterion.group !== "string" || !criterion.group.trim())) throw new Error("benchmark criterion group must be a nonempty string");
    criterionIds.add(criterion.id);
    const unitIds = new Set<string>();
    for (const unit of criterion.units) {
      if (!unit.id || unitIds.has(unit.id)) throw new Error(`duplicate or empty benchmark unit ID in ${criterion.id}`);
      unitIds.add(unit.id);
      if (![0, 1, 2, "U", "N/A"].includes(unit.score)) throw new Error(`invalid benchmark mark in ${criterion.id}/${unit.id}`);
      if (unit.score === "N/A" && !unit.reason.trim()) throw new Error(`N/A requires its branch reason in ${criterion.id}/${unit.id}`);
    }
    if (!criterion.units.length) limitations.push(`${criterion.id}: no unit evidence supplied; treated as unmeasured.`);
  }
  const operational = criteria.filter((criterion) => !criterion.reporting);
  const reporting = criteria.filter((criterion) => criterion.reporting);
  const familyIds = [...new Set(operational.map((criterion) => criterion.family))];
  const families = familyIds.map((id) => familyScore(id, operational.filter((criterion) => criterion.family === id)));
  const familyStructureComplete = familyIds.length === 5;
  if (!familyStructureComplete) limitations.push(`Expected five operational families; received ${familyIds.length}. Utility is not comparable.`);
  if (!reporting.length) limitations.push("No reporting fidelity criteria supplied; reporting is unmeasured.");
  const snapshotsPresent = !!input.snapshots.before && !!input.snapshots.after;
  if (!snapshotsPresent) limitations.push("A domain snapshot path is missing; evidence coverage is incomplete.");
  const horizonComplete = input.completion === "complete" && input.completedTicks === input.plannedTicks && input.completedThrough !== null;
  if (input.completion === "failed") limitations.push("Failed execution or evidence capture: completed tick count does not establish a complete horizon.");
  if (!horizonComplete) limitations.push(`Incomplete horizon: ${input.completedTicks}/${input.plannedTicks} opportunities; only observed results are available.`);

  const units = criteria.flatMap((criterion) => criterion.units);
  const measuredUnits = units.filter((unit) => typeof unit.score === "number").length;
  const notApplicableUnits = units.filter((unit) => unit.score === "N/A").length;
  // Empty rows represent missing measurements, not a denominator exemption.
  const unmeasuredUnits = units.filter((unit) => unit.score === "U").length + criteria.filter((criterion) => !criterion.units.length).length;
  const applicableUnits = measuredUnits + unmeasuredUnits;
  const fullyMeasured = unmeasuredUnits === 0 && familyStructureComplete && reporting.length > 0 && snapshotsPresent;
  const utilityMeasured = !operational.some(unmeasured) && familyStructureComplete && snapshotsPresent;
  const reportingMeasured = reporting.length > 0 && !reporting.some(unmeasured) && snapshotsPresent;
  const observedUtility = percent(mean(families.map((family) => family.observedScore)));
  const observedReporting = percent(groupedMean(reporting));
  return {
    kind: "continuity", caseId: input.caseId, version: 1,
    criteria, incidents: structuredClone(input.incidents), limitations: [...new Set(limitations)],
    completedTicks: input.completedTicks, plannedTicks: input.plannedTicks, completion: input.completion,
    completedThrough: input.completedThrough, snapshots: { ...input.snapshots },
    coverage: { totalUnits: applicableUnits + notApplicableUnits, measuredUnits, unmeasuredUnits,
      notApplicableUnits, fraction: applicableUnits ? measuredUnits / applicableUnits : null,
      horizonComplete, fullyMeasured },
    comparable: horizonComplete && fullyMeasured && observedUtility !== null && observedReporting !== null,
    utility: { score: horizonComplete && utilityMeasured ? observedUtility : null,
      observedScore: observedUtility, families,
      fullyCompletedFamilies: families.filter((family) => family.score === 2).length,
      applicableFamilies: families.filter((family) => family.score !== null || family.observedScore !== null ||
        operational.some((criterion) => criterion.family === family.id && unmeasured(criterion))).length },
    reporting: { score: horizonComplete && reportingMeasured ? observedReporting : null,
      observedScore: observedReporting, criteria: reporting.map((criterion) => criterion.id) },
  };
}
