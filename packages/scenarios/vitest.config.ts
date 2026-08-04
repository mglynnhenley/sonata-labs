import path from "node:path";
import { defineConfig } from "vitest/config";

// The aliases mirror tsconfig `paths`. Both are needed: the sibling packages are
// consumed as TypeScript source, so nothing links them into node_modules and a
// bare specifier would not resolve at test time. `@sonata/judge` is test-only —
// the spec tests check every criterion against the checkers that will score it.
export default defineConfig({
  resolve: {
    alias: {
      "@sonata/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
      "@sonata/judge/checklist": path.resolve(import.meta.dirname, "../judge/src/checklist.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
