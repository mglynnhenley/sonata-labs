import { describe, expect, it } from "vitest";
import { normalizeSessionTiming } from "../src/timing";

describe("versioned session timing", () => {
  it("preserves the historical default and copies validated candidate settings", () => {
    expect(normalizeSessionTiming(undefined)).toEqual({ policy: "compressed-wall-time" });
    const candidate = { policy: "provider-operations-v1", workUnitsPerTick: 12 };
    expect(normalizeSessionTiming(candidate)).toEqual(candidate);
    expect(normalizeSessionTiming(candidate)).not.toBe(candidate);
  });

  it.each([
    null, "provider-operations-v1", {}, { policy: "unknown" },
    { policy: "compressed-wall-time", workUnitsPerTick: 12 },
    ...[0, -1, 1.5, 10_001, Infinity, NaN, "12", undefined].map(workUnitsPerTick => ({ policy: "provider-operations-v1", workUnitsPerTick })),
    { policy: "provider-operations-v1", workUnitsPerTick: 12, unknown: true },
  ])("rejects ambiguous or invalid timing: %j", value => {
    expect(() => normalizeSessionTiming(value)).toThrow();
  });
});
