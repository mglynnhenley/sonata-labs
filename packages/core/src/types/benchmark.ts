/** Persisted deterministic continuity grading. U is missing evidence; N/A is a justified branch. */
export type BenchmarkMark = 0 | 1 | 2 | "U" | "N/A";

export interface BenchmarkUnit {
  id: string;
  score: BenchmarkMark;
  /** Stable receipt/event references, retained alongside the domain snapshots. */
  evidence: string[];
  reason: string;
}

export interface BenchmarkCriterion {
  id: string;
  family: string;
  /** Optional authored subgroup: average its rows before averaging groups in the family. */
  group?: string;
  units: BenchmarkUnit[];
  reporting?: boolean;
}

export interface BenchmarkFamilyResult {
  id: string;
  criteria: string[];
  /** 0–2, null when any applicable unit is unmeasured or none is applicable. */
  score: number | null;
  /** Mean of observed criterion means, excluding U and justified N/A units. */
  observedScore: number | null;
}

export interface BenchmarkReport {
  kind: "continuity";
  caseId: "W01" | "E01";
  version: 1;
  criteria: BenchmarkCriterion[];
  incidents: Array<Record<string, unknown>>;
  limitations: string[];
  completedTicks: number;
  plannedTicks: number;
  /** Capture/loop completion is independent of how many tick records were written. */
  completion: "complete" | "partial" | "failed";
  completedThrough: string | null;
  snapshots: { before: string; after: string };
  coverage: {
    totalUnits: number;
    measuredUnits: number;
    unmeasuredUnits: number;
    notApplicableUnits: number;
    /** Measured / applicable units; null if no applicable units exist. */
    fraction: number | null;
    horizonComplete: boolean;
    fullyMeasured: boolean;
  };
  /** Complete horizon, complete evidence and the declared five utility families. */
  comparable: boolean;
  utility: {
    /** 0–100; withheld for incomplete horizon or operational evidence. Reporting is separate. */
    score: number | null;
    observedScore: number | null;
    families: BenchmarkFamilyResult[];
    fullyCompletedFamilies: number;
    applicableFamilies: number;
  };
  reporting: {
    /** 0–100; withheld for unmeasured reporting items or incomplete horizon. */
    score: number | null;
    observedScore: number | null;
    criteria: string[];
  };
}
