import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import type { CloneFiles } from "./apps";
import { AUDIT_TABLES } from "./apps";
import type {
  DatabaseObservation,
  DependencyFacts,
  EnvFile,
  HttpAnswer,
  NodeVersion,
  PortObservation,
  SchemaFacts,
} from "./diagnose";
import { KEY_NAME, parseEngineFloor, parseEnvKeys, parseSchema } from "./diagnose";
import { REPO_ROOT, short } from "./repo";

// The machine, read and nothing else.
//
// Every function here answers a question about the world and returns plain data
// for ./diagnose to interpret. Nothing in this file writes, creates or starts
// anything: `sonata doctor` runs on a live install, mid-run, at any time, and
// the one thing it must never do is change what it is describing. That includes
// sqlite — every database is opened readonly and must already exist, because
// better-sqlite3 creates the file it is pointed at otherwise.

const HEALTH_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 400;

/**
 * Is anything listening? The twin registry keeps its own copy of this and does
 * not export it; the two are the same four lines of `net.connect`, and the
 * question ("is the port taken") has no product behaviour to drift.
 */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Health as text, never parsed here: a clone with no tables answers 500 with a
 *  plain-text body, and `res.json()` on that throws away the only useful line. */
async function health(port: number): Promise<HttpAnswer | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

export async function probePort(port: number): Promise<PortObservation> {
  if (!(await listening(port))) return { listening: false, health: null };
  return { listening: true, health: await health(port) };
}

// ---------------------------------------------------------------------------
// .env and the stored key
// ---------------------------------------------------------------------------

/** The Node the repo says it needs, or null if it does not say. */
export function declaredNodeFloor(): NodeVersion | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    return parseEngineFloor(pkg.engines?.node);
  } catch {
    return null;
  }
}

/**
 * The files the CLIs load, in their order of precedence — the same three, in the
 * same order, as apps/platform/src/cli/env.ts. Missing one here does not make it
 * stop working; it makes the doctor say "no key anywhere" to someone who has one.
 */
export function envFilePaths(): string[] {
  return [
    path.join(REPO_ROOT, "apps", "platform", ".env"),
    path.join(REPO_ROOT, ".env"),
    path.join(REPO_ROOT, "apps", "gmail", ".env"),
  ];
}

export function readEnvFiles(): EnvFile[] {
  return envFilePaths().map((file) => {
    if (!existsSync(file)) return { path: short(file), exists: false, keys: new Map() };
    try {
      return { path: short(file), exists: true, keys: parseEnvKeys(readFileSync(file, "utf8")) };
    } catch {
      return { path: short(file), exists: true, keys: new Map() };
    }
  });
}

/**
 * The key-shaped stand-in .env.example ships, or null if it ships none.
 *
 * Read rather than remembered: `cp .env.example .env` is step one, and if this
 * string were repeated here it would go stale the day the example changed and
 * the doctor would start calling a placeholder a working key.
 */
export function placeholderKey(): string | null {
  try {
    const text = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    return parseEnvKeys(text).get(KEY_NAME) || null;
  } catch {
    return null;
  }
}

/**
 * Is a key saved through Settings? That is a different source from .env — it
 * lives in platform.db — and a doctor that missed it would tell someone with a
 * working install to go and get a key.
 *
 * Read-only, and only if the file is already there: opening platform.db to ask
 * would create it.
 */
export async function keyInSettings(platformDbPath: string): Promise<boolean> {
  if (!existsSync(platformDbPath)) return false;
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(platformDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = 'openrouter.apiKey'")
        .get() as { value?: string } | undefined;
      return typeof row?.value === "string" && row.value.length > 0;
    } finally {
      db.close();
    }
  } catch {
    // No settings table yet, or a database mid-write. Absence of evidence.
    return false;
  }
}

export function keyInShell(): boolean {
  return typeof process.env[KEY_NAME] === "string" && process.env[KEY_NAME].length > 0;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Packages that must be linked into the root node_modules for anything to run. */
const REQUIRED_LINKS = ["@sonata/core", "@sonata/engine", "@sonata/judge", "next", "better-sqlite3"];

export async function dependencyFacts(): Promise<DependencyFacts> {
  const modules = path.join(REPO_ROOT, "node_modules");
  const installCommand = `cd ${REPO_ROOT} && npm install`;
  if (!existsSync(modules)) {
    return { installed: false, missingLinks: [], sqlite: "ok", installCommand };
  }
  const missingLinks = REQUIRED_LINKS.filter((name) => !existsSync(path.join(modules, name)));

  let sqlite = "ok";
  try {
    const { default: Database } = await import("better-sqlite3");
    new Database(":memory:").close();
  } catch (err) {
    sqlite = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  return { installed: true, missingLinks, sqlite, installCommand };
}

// ---------------------------------------------------------------------------
// A clone's databases against its schema
// ---------------------------------------------------------------------------

async function readObjects(file: string): Promise<Pick<DatabaseObservation, "objects" | "error">> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[];
      return { objects: rows.map((r) => r.name), error: null };
    } finally {
      db.close();
    }
  } catch (err) {
    return { objects: null, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

export async function schemaFacts(label: string, clone: CloneFiles): Promise<SchemaFacts> {
  const schemaExists = existsSync(clone.schemaPath);
  const declared = schemaExists
    ? parseSchema(readFileSync(clone.schemaPath, "utf8"))
    : { tables: [], indexes: [] };

  const databases: DatabaseObservation[] = [];
  for (const db of clone.databases) {
    if (!existsSync(db.path)) {
      databases.push({ file: db.file, exists: false, objects: null, error: null, expects: db.expects });
      continue;
    }
    const read = await readObjects(db.path);
    databases.push({ file: db.file, exists: true, expects: db.expects, ...read });
  }

  return {
    label,
    workspace: clone.workspace,
    schemaPath: short(clone.schemaPath),
    schemaExists,
    declared,
    auditTables: AUDIT_TABLES,
    databases,
  };
}
