import path from "node:path";
import { defineConfig } from "vitest/config";

// The alias mirrors tsconfig `paths`. Workspace symlinks resolve @sonata/core on
// an installed tree, but pointing straight at the source keeps tests running (and
// type-identical) before an install has happened.
export default defineConfig({
  resolve: {
    alias: {
      "@sonata/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
