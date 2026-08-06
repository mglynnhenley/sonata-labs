import path from "node:path";
import { defineConfig } from "vitest/config";

// The dashboard's own tests. Node environment, no jsdom: what is tested here is
// the run funnel — what gets written down when a day ends — not the React.
export default defineConfig({
  resolve: {
    // The same alias tsconfig gives the app, so a test imports a module by the
    // path the module itself uses.
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
