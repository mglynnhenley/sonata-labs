/** Versioned business-time assumptions, separate from real execution limits. */
export type SessionTimingPolicy =
  | { policy: "compressed-wall-time" }
  | { policy: "provider-operations-v1"; workUnitsPerTick: number };

/** One validation path for API input, saved configuration and engine callers. */
export function normalizeSessionTiming(value: unknown): SessionTimingPolicy {
  if (value === undefined) return { policy: "compressed-wall-time" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("timing must be a timing policy object");
  }
  const timing = value as Record<string, unknown>;
  if (timing.policy === "compressed-wall-time" && Object.keys(timing).length === 1) {
    return { policy: "compressed-wall-time" };
  }
  if (timing.policy === "provider-operations-v1" && Object.keys(timing).length === 2 &&
      Number.isInteger(timing.workUnitsPerTick) && Number(timing.workUnitsPerTick) >= 1 &&
      Number(timing.workUnitsPerTick) <= 10_000) {
    return { policy: "provider-operations-v1", workUnitsPerTick: Number(timing.workUnitsPerTick) };
  }
  throw new Error("timing must use compressed-wall-time, or provider-operations-v1 with integer workUnitsPerTick from 1 to 10000");
}

/** Engine attribution of an admitted provider operation; never supplied by an app. */
export interface LogicalActionTime {
  actionId: string;
  tick: number;
  simTimeISO: string;
}

export interface SessionActionRecord {
  actionId: string;
  operation: string;
  /** Experimental operation allowance, not a measurement of human effort. */
  workUnits: number;
  fromWorkUnits: number;
  completionWorkUnits: number;
  completionTick: number;
  simTimeISO: string;
  admittedAt: number;
  completedAt?: number;
  /** Completed means the request drained, including requests rejected by an app. */
  state: "admitted" | "completed" | "rejected";
  reason?: string;
}
