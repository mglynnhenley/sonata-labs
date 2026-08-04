import path from "node:path";
import { defineConfig } from "vitest/config";

// The aliases mirror tsconfig `paths`. Both are needed: the siblings are consumed
// as TypeScript source, so nothing links them into node_modules and a bare
// specifier would not resolve at test time.
export default defineConfig({
  resolve: {
    alias: {
      "@sonata/core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
      "@sonata/judge": path.resolve(import.meta.dirname, "../judge/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
