import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the repo is, and the one directory the rest of Sonata resolves itself
// from.

/**
 * The workspace root, found from this file rather than from `process.cwd()`.
 *
 * The point of a CLI is that it runs from anywhere — a stranger's first command
 * is as likely to be typed in their home directory as in the checkout — and
 * `packages/cli/src` is always three levels under the root it belongs to.
 */
export const REPO_ROOT: string = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..", "..");
  if (!existsSync(path.join(root, "apps", "platform"))) {
    throw new Error(
      `@sonata/cli is installed at ${here}, which is not inside a Sonata checkout ` +
        "(no apps/platform above it). Run it from the repo, or reinstall it there.",
    );
  }
  return root;
})();

export const PLATFORM_DIR: string = path.join(REPO_ROOT, "apps", "platform");

/**
 * Stand in apps/platform, exactly as the platform's own CLI does.
 *
 * platform.db, data/runs and the twins' log directory are all resolved from the
 * working directory — that is what makes the dashboard and the terminal agree on
 * one database without an environment variable. A command that started a twin
 * from somewhere else would register it in a second, empty platform.db.
 *
 * Must run before anything imports the twin registry: those paths are computed
 * when that module is first evaluated.
 */
export function enterPlatform(): void {
  if (process.cwd() !== PLATFORM_DIR) process.chdir(PLATFORM_DIR);
}

/** A path as a reader would type it: relative to the checkout, never absolute
 *  noise from someone else's home directory. */
export function short(target: string): string {
  const rel = path.relative(REPO_ROOT, target);
  return rel.startsWith("..") ? target : rel;
}
