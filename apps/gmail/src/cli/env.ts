// Load `.env` for the CLIs. The Next dev server reads .env on its own; tsx does not,
// so without this an OPENROUTER_API_KEY sitting in .env is silently ignored.
//
// Import this FIRST, before anything that reaches llm.ts: DEFAULT_MODEL and
// OPENROUTER_BASE_URL are read at module scope (llm.ts:13,17), and ESM evaluates
// imports before the importing module's body — so a call placed in main() runs too late.
//
// process.loadEnvFile is built into Node (>=20.12); no dependency needed. It does not
// overwrite variables already set, so an explicit `OPENROUTER_API_KEY=… npm run eval`
// still wins over the file.

import path from "node:path";

try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  // No .env, or unreadable — env vars may still come from the shell.
}
