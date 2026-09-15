import { CRITERION_KINDS } from "@sonata/core";
import { expect, it } from "vitest";
import { routeFor } from "../src/checklist";

it("only routes explicit judged Excel criteria to assessment; no deterministic kind can falsely pass", () => {
  for (const kind of CRITERION_KINDS) {
    expect(routeFor("excel", kind).via).toBe(kind === "judged" ? "judge" : "wrong-surface");
  }
});
