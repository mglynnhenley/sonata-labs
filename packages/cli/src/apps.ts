import path from "node:path";
import type { TwinName } from "@sonata/core";
import { PLATFORM_DIR, REPO_ROOT } from "./repo";

// The four things `sonata up` starts, described once.
//
// The three clones' ports come from the twin registry in apps/platform, not from
// a table of our own: the dashboard, the engine and this CLI have to agree about
// where Gmail is, and two lists of ports would drift the day one of them moved.

export type AppName = "platform" | TwinName;

/** The databases a clone serves from, and what each one is expected to contain. */
export interface CloneDatabase {
  /** "working.db" — as the AGENTS.md instructions name it. */
  file: string;
  path: string;
  /**
   * `full` files carry every object db/schema.sql declares. `audit` files carry
   * only the two audit tables — that is all apps/*\/src/lib/db.ts ever attaches
   * and creates there, so demanding the rest would invent a failure.
   */
  expects: "full" | "audit";
}

export interface CloneFiles {
  schemaPath: string;
  dataDir: string;
  databases: CloneDatabase[];
  /** The workspace path `npm -w` wants: "apps/gmail". */
  workspace: string;
}

export interface AppSpec {
  name: AppName;
  label: string;
  dir: string;
  port: number;
  url: string;
  /** The root script that boots it: `npm run dev:gmail`. */
  devScript: string;
  /** Null for the dashboard, which keeps one database and creates it itself. */
  clone: CloneFiles | null;
}

/** The audit file's whole contents, per the ATTACHed DDL in each clone's db.ts. */
export const AUDIT_TABLES = ["sessions", "action_log"] as const;

/** The twin registry, loaded late. */
export type TwinRegistry = typeof import("../../../apps/platform/src/lib/twins");

/**
 * A prerequisite so broken that no other check can run: the twin registry could
 * not even be loaded. It reaches better-sqlite3, so this is what an install that
 * never happened — or a native module built for a different Node — looks like.
 */
export class PrerequisiteError extends Error {
  readonly fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.name = "PrerequisiteError";
    this.fix = fix;
  }
}

let registry: TwinRegistry | null = null;

/**
 * The twin registry — the supervisor the dashboard's Start buttons use.
 *
 * `enterPlatform()` must already have run: this module resolves platform.db and
 * the twins' log directory from the working directory at import time.
 */
export async function loadTwins(): Promise<TwinRegistry> {
  if (registry) return registry;
  try {
    registry = await import("../../../apps/platform/src/lib/twins");
    return registry;
  } catch (err) {
    const said = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new PrerequisiteError(
      `Sonata's dependencies are not usable — the twin registry would not load: ${said}`,
      /NODE_MODULE_VERSION|invalid ELF|was compiled against/i.test(said)
        ? `cd ${REPO_ROOT} && npm rebuild better-sqlite3   (a native module built for another Node)`
        : `cd ${REPO_ROOT} && npm install`,
    );
  }
}

function cloneFiles(twin: TwinName): CloneFiles {
  const dir = path.join(REPO_ROOT, "apps", twin);
  const dataDir = path.join(dir, "data");
  return {
    schemaPath: path.join(dir, "db", "schema.sql"),
    dataDir,
    workspace: `apps/${twin}`,
    databases: [
      { file: "working.db", path: path.join(dataDir, "working.db"), expects: "full" },
      { file: "snapshot.db", path: path.join(dataDir, "snapshot.db"), expects: "full" },
      { file: "audit.db", path: path.join(dataDir, "audit.db"), expects: "audit" },
    ],
  };
}

/**
 * The dashboard's port. It is not a twin, so it is not in TWIN_PORTS; the number
 * lives in apps/platform's own dev script (`next dev --port 3000`) and is
 * repeated here because a supervisor has to know where to look for health.
 */
export const PLATFORM_PORT = 3000;

export async function loadApps(): Promise<AppSpec[]> {
  const twins = await loadTwins();
  return [
    {
      name: "platform",
      label: "Dashboard",
      dir: PLATFORM_DIR,
      port: PLATFORM_PORT,
      url: `http://localhost:${PLATFORM_PORT}`,
      devScript: "dev:platform",
      clone: null,
    },
    ...(["gmail", "slack", "calendar"] as const).map((twin) => ({
      name: twin,
      label: twins.TWIN_LABELS[twin],
      dir: path.join(REPO_ROOT, "apps", twin),
      port: twins.TWIN_PORTS[twin],
      url: twins.twinUrl(twin),
      devScript: `dev:${twin}`,
      clone: cloneFiles(twin),
    })),
  ];
}
