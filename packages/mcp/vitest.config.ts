import path from "node:path";
import { defineConfig } from "vitest/config";

// The aliases mirror tsconfig `paths`. Both are needed: the siblings are consumed
// as TypeScript source, so nothing links them into node_modules and a bare
// specifier would not resolve at test time. The engine entry is a regex because
// this package reaches into it by deep path (`@sonata/engine/tools/index`) rather
// than through the barrel — importing the barrel would drag the OpenAI SDK and
// the whole run loop into a process whose only job is to answer stdio.

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sonata\/core$/, replacement: path.resolve(import.meta.dirname, "../core/src/index.ts") },
      {
        find: /^@sonata\/engine\/(.*)$/,
        replacement: `${path.resolve(import.meta.dirname, "../engine/src")}/$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
