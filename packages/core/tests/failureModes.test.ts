import { describe, expect, it } from "vitest";
import {
  FAILURE_MODES,
  failureModeIds,
  failureModesByCategory,
  getFailureMode,
  isFailureModeId,
} from "../src/failureModes";

// The catalog is persisted data: ids live forever inside judge artifacts, and a
// renamed id silently orphans every finding that used it. So the properties
// under test are about the catalog as a stable public key space, not about
// wording.

describe("the catalog", () => {
  it("has unique ids", () => {
    expect(new Set(failureModeIds()).size).toBe(FAILURE_MODES.length);
  });

  it("still carries every mode the Gmail judge shipped with", () => {
    const inherited = [
      "acted-without-reading",
      "bulk-swept",
      "missed-history",
      "replied-on-guess",
      "wrong-recipients",
      "destructive-overreach",
      "ignored-probe",
      "date-blind",
      "tone-mismatch",
      "overconfident",
      "task-drift",
    ];
    for (const id of inherited) expect(isFailureModeId(id)).toBe(true);
  });

  it("covers the four autonomy modes the episode judge adds", () => {
    expect(failureModesByCategory("autonomy").map((m) => m.id).sort()).toEqual([
      "asked-instead-of-acting",
      "dropped-thread",
      "over-escalated",
      "stalled",
    ]);
  });

  it("covers both cross-surface modes", () => {
    expect(failureModesByCategory("cross-surface").map((m) => m.id).sort()).toEqual([
      "cross-surface-inconsistency",
      "surface-siloed",
    ]);
  });

  it("names no single channel in any question — the modes are surface-neutral", () => {
    // "inbox", "mailbox" and "Gmail" would make a mode unaskable of a calendar run.
    for (const mode of FAILURE_MODES) {
      expect(mode.question.toLowerCase()).not.toMatch(/inbox|mailbox|gmail|slack\b/);
    }
  });

  it("asks a real question of every mode", () => {
    for (const mode of FAILURE_MODES) {
      expect(mode.question.trim().endsWith("?")).toBe(true);
      expect(mode.label.length).toBeGreaterThan(0);
    }
  });
});

describe("lookups", () => {
  it("finds a mode by id and reports an unknown one as absent", () => {
    expect(getFailureMode("stalled")?.category).toBe("autonomy");
    expect(getFailureMode("nope")).toBeUndefined();
    expect(isFailureModeId("nope")).toBe(false);
  });
});
