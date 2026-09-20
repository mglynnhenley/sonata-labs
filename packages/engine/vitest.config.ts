import path from "node:path";
import { defineConfig } from "vitest/config";

// The aliases mirror tsconfig's `paths` for the same reason: tests must run from
// a fresh checkout without waiting on a workspace link. The scenarios entry is a
// regex because the desk domains reach a single authored week by deep path
// (`@sonata/scenarios/electricityContinuity`) rather than through the barrel.

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: [
      { find: /^@sonata\/core$/, replacement: path.resolve(import.meta.dirname, "../core/src/index.ts") },
      { find: /^@sonata\/desks$/, replacement: path.resolve(import.meta.dirname, "../desks/src/index.ts") },
      { find: /^@sonata\/scenarios$/, replacement: path.resolve(import.meta.dirname, "../scenarios/src/index.ts") },
      {
        find: /^@sonata\/scenarios\/(.*)$/,
        replacement: `${path.resolve(import.meta.dirname, "../scenarios/src")}/$1.ts`,
      },
      {
        find: /^@sonata\/judge\/(.*)$/,
        replacement: `${path.resolve(import.meta.dirname, "../judge/src")}/$1.ts`,
      },
    ],
  },
});
