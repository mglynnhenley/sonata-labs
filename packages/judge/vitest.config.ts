import path from "node:path";
import { defineConfig } from "vitest/config";

// The alias mirrors tsconfig `paths`. Both are needed: @sonata/core is consumed as
// TypeScript source, so nothing links it into node_modules and a bare specifier
// would not resolve at test time.
export default defineConfig({
  resolve: {
    alias: {
      "@sonata/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
