import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { PLATFORM_DIR } from "./repo";

// world, run, judge, bench, status, reconcile, prune already exist, and they are
// the product: every one of them calls the same function the matching button on
// the dashboard calls. This CLI adds the four commands that come before them and
// hands the rest straight through — a second implementation of `run` would be a
// second way to play a day, which is exactly the drift this repo keeps paying
// for.

const ENGINE_CLI = path.join(PLATFORM_DIR, "src", "cli", "sonata.ts");

/** The commands apps/platform/src/cli/sonata.ts dispatches. */
export const ENGINE_COMMANDS = ["world", "run", "judge", "bench", "status", "reconcile", "prune"];

export function passthrough(args: string[]): Promise<number> {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  // From apps/platform, not from the repo root: that CLI's imports go through
  // the app's own tsconfig paths (`@/lib/…`), which tsx resolves from the
  // working directory, and its data lives there too.
  const child = spawn(process.execPath, [tsxCli, ENGINE_CLI, ...args], {
    cwd: PLATFORM_DIR,
    stdio: "inherit",
  });

  // A run in progress handles its own Ctrl-C — it stops at the next tick and
  // still writes the artifact. The parent must not exit first and orphan it.
  const ignore = () => {};
  process.on("SIGINT", ignore);

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(signal ? 130 : (code ?? 0));
    });
  });
}
