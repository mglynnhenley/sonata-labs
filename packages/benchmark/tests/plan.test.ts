import { describe, expect, it } from "vitest";
import { cellRunId, matrixSize, planMatrix, slug, type BenchmarkMatrix } from "../src/plan";
import { MATRIX } from "./fixtures";

// A benchmark is hours of billable calls and it WILL be interrupted, so the two
// properties under test here are the ones resume rests on: cell ids depend on
// nothing but the matrix, and a cell already on disk is never paid for twice.

describe("slug", () => {
  it("produces filename-safe names that match the judge's run-id rule", () => {
    expect(slug("anthropic/claude-haiku-4.5")).toBe("anthropic-claude-haiku-4.5");
    expect(slug("The SLA Escalation!")).toBe("the-sla-escalation");
    expect(slug("--trim--")).toBe("trim");
    expect(/^[\w.-]+$/.test(slug("openai/gpt-5-mini"))).toBe(true);
  });

  it("never returns an empty component", () => {
    // "" would make "a--<empty>--s0" alias a different cell's artifact.
    expect(slug("///")).toBe("x");
    expect(slug("")).toBe("x");
  });
});

describe("cellRunId", () => {
  it("is a pure function of its four inputs", () => {
    const a = cellRunId("bench1", "sla-escalation", "openai/gpt-5-mini", 2);
    const b = cellRunId("bench1", "sla-escalation", "openai/gpt-5-mini", 2);
    expect(a).toBe(b);
    expect(a).toBe("bench1--sla-escalation--openai-gpt-5-mini--s2");
  });

  it("separates on every axis", () => {
    const base = cellRunId("b", "s", "m", 0);
    expect(cellRunId("b2", "s", "m", 0)).not.toBe(base);
    expect(cellRunId("b", "s2", "m", 0)).not.toBe(base);
    expect(cellRunId("b", "s", "m2", 0)).not.toBe(base);
    expect(cellRunId("b", "s", "m", 1)).not.toBe(base);
  });
});

describe("planMatrix", () => {
  it("expands every combination exactly once", () => {
    const plan = planMatrix(MATRIX);
    expect(plan.cells).toHaveLength(matrixSize(MATRIX));
    expect(plan.cells).toHaveLength(8);
    expect(new Set(plan.cells.map((c) => c.runId)).size).toBe(8);
    expect(plan.cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders seed-outermost so an interrupted run still fills the table once", () => {
    const plan = planMatrix(MATRIX);
    // Seed 1 covers the whole table before seed 2 begins.
    expect(plan.cells.slice(0, 4).every((c) => c.seed === 1)).toBe(true);
    expect(plan.cells.slice(4).every((c) => c.seed === 2)).toBe(true);
    expect(plan.cells.slice(0, 4).map((c) => `${c.scenarioId}/${c.model}`)).toEqual([
      "sla-escalation/anthropic/claude-haiku-4.5",
      "sla-escalation/openai/gpt-5-mini",
      "quiet-monday/anthropic/claude-haiku-4.5",
      "quiet-monday/openai/gpt-5-mini",
    ]);
  });

  it("skips cells whose artifact is already on disk", () => {
    const done = [
      cellRunId(MATRIX.id, "sla-escalation", "anthropic/claude-haiku-4.5", 1),
      cellRunId(MATRIX.id, "quiet-monday", "openai/gpt-5-mini", 2),
    ];
    const plan = planMatrix(MATRIX, done);

    expect(plan.done.map((c) => c.runId).sort()).toEqual([...done].sort());
    expect(plan.pending).toHaveLength(6);
    expect(plan.pending.some((c) => done.includes(c.runId))).toBe(false);
    // Resume splits the matrix; it never shrinks it.
    expect(plan.pending.length + plan.done.length).toBe(plan.cells.length);
  });

  it("plans nothing when everything has already run", () => {
    const first = planMatrix(MATRIX);
    const second = planMatrix(MATRIX, first.cells.map((c) => c.runId));
    expect(second.pending).toEqual([]);
    expect(second.done).toHaveLength(8);
  });

  it("ignores run ids on disk that are not in this matrix", () => {
    const plan = planMatrix(MATRIX, ["some-other-benchmark--x--y--s0"]);
    expect(plan.pending).toHaveLength(8);
    expect(plan.done).toEqual([]);
  });

  it("rejects an empty axis rather than silently planning nothing", () => {
    expect(() => planMatrix({ ...MATRIX, models: [] })).toThrow(/no models/);
    expect(() => planMatrix({ ...MATRIX, scenarioIds: [] })).toThrow(/no scenarios/);
    expect(() => planMatrix({ ...MATRIX, seeds: [] })).toThrow(/no seeds/);
  });

  it("rejects duplicates, which would run one cell twice into one artifact", () => {
    expect(() => planMatrix({ ...MATRIX, seeds: [1, 1] })).toThrow(/Duplicate seed/);
    expect(() => planMatrix({ ...MATRIX, models: ["a", "a"] })).toThrow(/Duplicate model/);
  });

  it("rejects distinct entries whose slugs collide", () => {
    // "A/b" and "a-b" are different scenarios and one filename.
    const matrix: BenchmarkMatrix = { ...MATRIX, scenarioIds: ["A/b", "a-b"] };
    expect(() => planMatrix(matrix)).toThrow(/collision/);
  });
});
