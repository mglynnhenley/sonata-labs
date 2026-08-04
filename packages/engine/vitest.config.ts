import path from "node:path";
import { defineConfig } from "vitest/config";

// The alias mirrors tsconfig's `paths` for the same reason: tests must run from
// a fresh checkout without waiting on a workspace link.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@sonata/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
    },
  },
});
