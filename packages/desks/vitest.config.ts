import path from "node:path";
import { defineConfig } from "vitest/config";

// The aliases mirror tsconfig `paths`. Both are needed: the siblings are consumed
// as TypeScript source, so nothing links them into node_modules and a bare
// specifier would not resolve at test time. The scenarios entry is a regex
// because a domain reaches its own authored week by deep path
// (`@sonata/scenarios/electricityContinuity`) rather than through the barrel.

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sonata\/core$/, replacement: path.resolve(import.meta.dirname, "../core/src/index.ts") },
      { find: /^@sonata\/scenarios$/, replacement: path.resolve(import.meta.dirname, "../scenarios/src/index.ts") },
      {
        find: /^@sonata\/scenarios\/(.*)$/,
        replacement: `${path.resolve(import.meta.dirname, "../scenarios/src")}/$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
