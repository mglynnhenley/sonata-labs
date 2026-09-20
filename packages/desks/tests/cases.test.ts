import { describe, expect, it } from "vitest";
import { CONTINUITY_CASES, SqliteDeskStore, continuityCase } from "../src/index";

// The pairing invariant.
//
// A case is two halves of one authored week: the spec publishes the clock and
// the brief the agent reads, the domain holds the rules the assessment is made
// of. Pair the wrong halves and you get a week that runs, scores and means
// nothing — the agent working Monday's brief while the rules mark Tuesday. The
// engine refuses a mismatch at launch; these keep the halves from drifting in
// the first place.

describe("the authored continuity cases", () => {
  it("is resolvable by either id, and by nothing else", () => {
    expect(CONTINUITY_CASES.length).toBeGreaterThan(0);
    for (const desk of CONTINUITY_CASES) {
      expect(continuityCase(desk.domain.id)).toBe(desk);
      expect(continuityCase(desk.spec.id)).toBe(desk);
    }
    expect(continuityCase("not-a-case")).toBeUndefined();
  });

  it("declares the case id in both halves", () => {
    for (const desk of CONTINUITY_CASES) {
      expect(desk.spec.benchmark, `${desk.spec.id} must carry its benchmark marker`).toBeDefined();
      expect(desk.spec.benchmark!.caseId).toBe(desk.domain.id);
      expect(desk.spec.benchmark!.kind).toBe("continuity");
    }
  });

  it("authors one instant per opportunity, strictly increasing, ending before the horizon", () => {
    for (const { spec } of CONTINUITY_CASES) {
      const { tickISOs, endISO, ticks } = spec.clock;
      expect(tickISOs, `${spec.id} needs explicit instants: a week skips its nights`).toBeDefined();
      expect(tickISOs!).toHaveLength(ticks);
      expect(Date.parse(tickISOs![0]!)).toBe(Date.parse(spec.clock.startISO));
      for (let i = 1; i < tickISOs!.length; i++) {
        expect(Date.parse(tickISOs![i]!), `${spec.id} instant ${i}`).toBeGreaterThan(Date.parse(tickISOs![i - 1]!));
      }
      expect(Date.parse(endISO!)).toBeGreaterThan(Date.parse(tickISOs![ticks - 1]!));
    }
  });

  it("gives every tool a unique name and an object schema the agent can fill", () => {
    for (const { domain } of CONTINUITY_CASES) {
      const names = domain.tools.map((tool) => tool.name);
      expect(new Set(names).size, `${domain.id} has a duplicate tool name`).toBe(names.length);
      for (const tool of domain.tools) {
        expect(tool.description.length, `${domain.id}:${tool.name} needs a description`).toBeGreaterThan(0);
        expect((tool.parameters as { type?: string }).type).toBe("object");
      }
      // A week the agent can only read is not a week it can work.
      expect(domain.tools.some((tool) => tool.mutation), `${domain.id} has no mutating tool`).toBe(true);
    }
  });

  it("seeds a week that assesses as unmeasured before anyone has worked it", () => {
    for (const desk of CONTINUITY_CASES) {
      const store = new SqliteDeskStore(":memory:");
      try {
        store.transaction(() => desk.domain.seed(store));
        expect(store.list().length, `${desk.domain.id} seeded nothing`).toBeGreaterThan(0);
        // Nothing has happened yet, so nothing is the agent's.
        expect(store.events().filter((event) => event.actor === "agent")).toEqual([]);

        // An unworked week is unmeasured, never zero: a score of nothing-done and
        // a score of not-yet-observed are different findings.
        const assessment = desk.domain.assess(store, null);
        const marks = assessment.criteria.flatMap((criterion) => criterion.units.map((unit) => unit.score));
        expect(marks.length, `${desk.domain.id} assessed no units`).toBeGreaterThan(0);
        expect(marks.every((mark) => mark === "U" || mark === "N/A"), `${desk.domain.id} scored an unobserved week`).toBe(true);
      } finally {
        store.close();
      }
    }
  });
});
