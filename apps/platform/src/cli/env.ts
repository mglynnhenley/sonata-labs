import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the .env files for the CLI. The Next dev server reads .env on its own;
// tsx does not, so without this an OPENROUTER_API_KEY sitting in a .env file is
// silently ignored and every model call fails with "no key".
//
// Import this FIRST, before anything that reaches a model module: slugs and base
// URLs are read at module scope, and ESM evaluates imports before the importing
// module's body — so a call placed in main() runs too late.
//
// `process.loadEnvFile` is built into Node (>=20.12) and does not overwrite what
// is already set, so the shell always wins and the files are read in order of
// specificity: this app, then the workspace root, then the Gmail twin — which is
// where the key has lived since before there was a dashboard.

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/cli → src → apps/platform */
const appDir = path.resolve(here, "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");

// platform.db and data/runs are resolved from the working directory, exactly as
// the dev server resolves them — that is what makes `npm run dev` and this CLI
// agree on one database without an environment variable. So the CLI moves to the
// app rather than opening a second, empty store wherever it happened to be run.
if (process.cwd() !== appDir) process.chdir(appDir);

for (const file of [
  path.join(appDir, ".env"),
  path.join(repoRoot, ".env"),
  path.join(repoRoot, "apps", "gmail", ".env"),
]) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch {
    // Unreadable or malformed: the shell may still carry the variables.
  }
}
