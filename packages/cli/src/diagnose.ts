// The diagnosis, with nothing plugged in.
//
// Everything here is a function from observations to sentences: no sockets, no
// files, no processes. That split is deliberate — the part of `sonata doctor`
// worth trusting is the part that decides what a symptom means and what clears
// it, and that part is only testable if it never touches the machine.
//
// The rule the whole file obeys: a check that is not ok carries a fix. The type
// enforces it, because a diagnosis without a next command is just bad news.

export type Check =
  | { status: "ok"; title: string; detail: string; note?: string }
  | { status: "warn" | "fail"; title: string; detail: string; fix: string; note?: string };

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface NodeVersion {
  major: number;
  minor: number;
}

/** 20.12 is where `process.loadEnvFile` landed — below it no CLI here sees .env.
 *  Only a floor: the repo's own `engines` field wins when it asks for more. */
export const MIN_NODE: NodeVersion = { major: 20, minor: 12 };

/**
 * The floor out of a package.json `engines.node`, which is the number the repo
 * itself publishes. Reading it beats hard-coding a second one here: this check
 * would otherwise pass a Node the rest of the install refuses to run on.
 */
export function parseEngineFloor(spec: string | undefined): NodeVersion | null {
  if (!spec) return null;
  const match = /(?:>=?|\^|~)?\s*(\d+)(?:\.(\d+))?/.exec(spec);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

export function nodeCheck(version: string, floor: NodeVersion = MIN_NODE): Check {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const wanted = `${floor.major}.${floor.minor}`;
  if (major < floor.major || (major === floor.major && minor < floor.minor)) {
    return {
      status: "fail",
      title: "Node",
      detail: `v${version.replace(/^v/, "")} — Sonata needs ${wanted} or newer`,
      fix: `nvm install ${floor.major} && nvm use ${floor.major}   (or install Node ${floor.major} from nodejs.org)`,
    };
  }
  return { status: "ok", title: "Node", detail: `v${version.replace(/^v/, "")} (needs ${wanted}+)` };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DependencyFacts {
  /** node_modules at the workspace root. */
  installed: boolean;
  /** Workspace links npm should have made: "@sonata/core", … */
  missingLinks: string[];
  /** The native module every database here goes through. */
  sqlite: "ok" | string;
  installCommand: string;
}

export function dependencyCheck(facts: DependencyFacts): Check {
  if (!facts.installed) {
    return {
      status: "fail",
      title: "Dependencies",
      detail: "no node_modules at the repo root — nothing is installed",
      fix: facts.installCommand,
    };
  }
  if (facts.missingLinks.length > 0) {
    return {
      status: "fail",
      title: "Dependencies",
      detail: `installed, but the workspaces are not linked: ${facts.missingLinks.join(", ")}`,
      fix: facts.installCommand,
    };
  }
  if (facts.sqlite !== "ok") {
    return {
      status: "fail",
      title: "Dependencies",
      detail: `better-sqlite3 will not load: ${facts.sqlite}`,
      fix: "npm rebuild better-sqlite3   (it is built against one Node; you are running another)",
    };
  }
  return { status: "ok", title: "Dependencies", detail: "installed, linked, better-sqlite3 loads" };
}

// ---------------------------------------------------------------------------
// .env and the API key
// ---------------------------------------------------------------------------

/** The one name that works. `OPEN_ROUTER_KEY` is silently ignored — see AGENTS.md. */
export const KEY_NAME = "OPENROUTER_API_KEY";

/** Names people actually type instead. Each one is a silent no-key run. */
const NEAR_MISSES = [
  "OPEN_ROUTER_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENROUTER_KEY",
  "OPENROUTER_APIKEY",
  "OPENROUTER_TOKEN",
  "OPENROUTER_API_TOKEN",
];

/** What a missing key costs, said in full so nobody discovers it mid-run. */
export const NO_KEY_MEANS =
  "the clones and the dashboard run, but no model can be reached: no agent run, " +
  "no judge, no benchmark. `world create` still works — it falls back to a template " +
  "rather than inventing a company.";

export interface EnvFile {
  /** Repo-relative, for printing. */
  path: string;
  exists: boolean;
  /** Parsed names and values; empty when the file is missing. */
  keys: Map<string, string>;
}

export interface KeyFacts {
  /** In the order the CLIs load them: the first file that sets a name wins. */
  files: EnvFile[];
  /** The shell already exports it — which beats every file. */
  inShell: boolean;
  /** A key saved through Settings, which lives in platform.db, not in a file. */
  inSettings: boolean;
  /** Where `sonata init` would write. */
  envPath: string;
  /**
   * The stand-in .env.example ships, read from that file rather than repeated
   * here. `cp .env.example .env` is the documented first step, so this exact
   * string is what a half-finished setup leaves behind — and a check that
   * called it a key would hand out a green tick and a run that dies on its
   * first model call.
   */
  placeholder?: string;
}

/**
 * KEY=value lines, near enough. Quotes are stripped and `export` is tolerated
 * because both appear in hand-written .env files; anything cleverer belongs to
 * the loader, not to a diagnosis of what a human typed.
 */
export function parseEnvKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const [, name = "", rest = ""] = match;
    const value = rest.trim().replace(/^(['"])(.*)\1$/, "$2");
    out.set(name, value);
  }
  return out;
}

export function envFileCheck(facts: KeyFacts): Check {
  const found = facts.files.filter((f) => f.exists);
  if (found.length === 0) {
    return {
      status: "warn",
      title: ".env",
      detail: `none found (looked for ${facts.files.map((f) => f.path).join(", ")})`,
      fix: `sonata init   — it writes ${facts.envPath} for you`,
    };
  }
  return {
    status: "ok",
    title: ".env",
    detail: `${found.map((f) => f.path).join(", ")} — and an exported variable beats any file`,
  };
}

export function apiKeyCheck(facts: KeyFacts): Check {
  if (facts.inShell) {
    return { status: "ok", title: "API key", detail: `${KEY_NAME} is exported in this shell` };
  }
  for (const file of facts.files) {
    const value = file.keys.get(KEY_NAME);
    if (!value) continue;
    if (facts.placeholder && value === facts.placeholder) {
      return {
        status: "warn",
        title: "API key",
        detail: `${file.path} still has .env.example's placeholder (${value})`,
        fix: `replace it with a real key in ${file.path} — https://openrouter.ai/keys`,
        note: NO_KEY_MEANS,
      };
    }
    return { status: "ok", title: "API key", detail: `${KEY_NAME} set in ${file.path}` };
  }
  if (facts.inSettings) {
    return {
      status: "ok",
      title: "API key",
      detail: "saved through Settings (it lives in platform.db, not in .env)",
    };
  }

  // The empty-value and misspelt-name cases are the ones worth being precise
  // about: both look set to the person who typed them, and neither is.
  for (const file of facts.files) {
    if (file.keys.get(KEY_NAME) === "") {
      return {
        status: "warn",
        title: "API key",
        detail: `${KEY_NAME} is in ${file.path} but empty`,
        fix: `put the key after the "=" in ${file.path}, or run sonata init`,
        note: NO_KEY_MEANS,
      };
    }
    for (const wrong of NEAR_MISSES) {
      if (file.keys.has(wrong)) {
        return {
          status: "fail",
          title: "API key",
          detail: `${file.path} sets ${wrong}; Sonata reads ${KEY_NAME} and nothing else`,
          fix: `rename it: ${wrong}= → ${KEY_NAME}= in ${file.path}`,
          note: NO_KEY_MEANS,
        };
      }
    }
  }

  return {
    status: "warn",
    title: "API key",
    detail: `no ${KEY_NAME} anywhere`,
    fix: `sonata init   (or add ${KEY_NAME}=sk-or-… to ${facts.envPath}) — https://openrouter.ai/keys`,
    note: NO_KEY_MEANS,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface HttpAnswer {
  status: number;
  /** The body verbatim: a clone with no tables answers 500 in plain text. */
  body: string;
}

export interface PortObservation {
  listening: boolean;
  /** What GET /api/health said, or null if it never answered. */
  health: HttpAnswer | null;
}

export type PortState =
  | { kind: "free" }
  | { kind: "sonata"; detail: string }
  | { kind: "sonata-broken"; detail: string }
  | { kind: "foreign"; detail: string };

/** Numbers a health payload volunteers, in the words it used. */
function describeHealth(body: Record<string, unknown>): string {
  const counts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "number" && key !== "activeRuns") counts.push(`${value} ${key}`);
  }
  return counts.length > 0 ? counts.join(" · ") : "healthy";
}

/**
 * What is on the port.
 *
 * Four answers, not two, because they need four different sentences: nothing
 * there (start it), Sonata (leave it), Sonata answering an error (the database
 * is usually behind its schema), and somebody else's server (free the port —
 * starting a second one here would only die on EADDRINUSE).
 *
 * "Is this Sonata?" is decided by the clones' own health contract: JSON with
 * `ok: true` or `status: "ok"`, which is what every apps/*\/api/health returns.
 */
export function classifyPort(o: PortObservation): PortState {
  if (!o.listening) return { kind: "free" };
  if (!o.health) {
    return { kind: "foreign", detail: "something is listening but never answered /api/health" };
  }

  let body: unknown;
  try {
    body = JSON.parse(o.health.body) as unknown;
  } catch {
    body = undefined;
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const healthy = record !== null && (record.ok === true || record.status === "ok");

  if (o.health.status === 200 && healthy) return { kind: "sonata", detail: describeHealth(record) };
  if (o.health.status === 404 || (o.health.status === 200 && !healthy)) {
    return { kind: "foreign", detail: `answered ${o.health.status} on /api/health — not a Sonata app` };
  }

  const said =
    (record && typeof record.error === "string" ? record.error : o.health.body.split("\n")[0]) ?? "";
  return {
    kind: "sonata-broken",
    detail: `answered ${o.health.status}${said ? `: ${said.slice(0, 120)}` : ""}`,
  };
}

export interface PortFacts {
  label: string;
  port: number;
  /** "sonata up gmail" — how this one is started. */
  startCommand: string;
  state: PortState;
}

export function portCheck(facts: PortFacts): Check {
  const title = `${facts.label} :${facts.port}`;
  switch (facts.state.kind) {
    case "sonata":
      return { status: "ok", title, detail: `serving — ${facts.state.detail}` };
    case "free":
      return {
        status: "warn",
        title,
        detail: "not running (the port is free, which is all `up` needs)",
        fix: facts.startCommand,
      };
    case "sonata-broken":
      return {
        status: "fail",
        title,
        detail: facts.state.detail,
        fix:
          "if the answer mentions a missing table, apply the schema (see the database check below); " +
          "otherwise read the log the start printed",
      };
    case "foreign":
      return {
        status: "fail",
        title,
        detail: facts.state.detail,
        fix: `free port ${facts.port}: lsof -ti tcp:${facts.port} | xargs kill   — then ${facts.startCommand}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Databases against their schema
// ---------------------------------------------------------------------------

export interface SchemaObjects {
  tables: string[];
  indexes: string[];
}

/**
 * The names db/schema.sql declares.
 *
 * Comments come out first so a commented-out table is not demanded, and a name
 * is taken bare: quoting and any `main.` qualifier are noise here, and sqlite
 * records the bare name in sqlite_master either way.
 */
export function parseSchema(sql: string): SchemaObjects {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const re =
    /create\s+(?:unique\s+)?(?:virtual\s+)?(table|index)\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`[\]]+)/gi;
  const tables: string[] = [];
  const indexes: string[] = [];
  for (const match of stripped.matchAll(re)) {
    const kind = (match[1] ?? "").toLowerCase();
    const name = (match[2] ?? "").replace(/[`"[\]]/g, "").split(".").pop();
    if (!name) continue;
    (kind === "table" ? tables : indexes).push(name);
  }
  return { tables: [...new Set(tables)], indexes: [...new Set(indexes)] };
}

export interface DatabaseObservation {
  /** "working.db" */
  file: string;
  exists: boolean;
  /** Every name in sqlite_master, or null if the file could not be read. */
  objects: string[] | null;
  /** Why it could not be read, if it could not. */
  error: string | null;
  /** `audit` files hold only the two audit tables; see AUDIT_TABLES. */
  expects: "full" | "audit";
}

export interface SchemaFacts {
  label: string;
  /** "apps/gmail" — what `npm -w` wants. */
  workspace: string;
  /** Repo-relative, for printing. */
  schemaPath: string;
  schemaExists: boolean;
  declared: SchemaObjects;
  /** The names an audit file is allowed to be judged against. */
  auditTables: readonly string[];
  databases: DatabaseObservation[];
}

/** Declared but absent. Never the reverse: sqlite keeps shadow tables of its own
 *  (messages_fts_data and friends), and a database ahead of its schema is a
 *  different problem from a database behind it. */
export function missingObjects(
  declared: SchemaObjects,
  db: DatabaseObservation,
  auditTables: readonly string[],
): string[] {
  const present = new Set(db.objects ?? []);
  const wantedTables =
    db.expects === "audit" ? declared.tables.filter((t) => auditTables.includes(t)) : declared.tables;
  const wantedIndexes =
    db.expects === "audit"
      ? declared.indexes.filter((i) => auditTables.some((t) => i.includes(t)))
      : declared.indexes;
  return [...wantedTables, ...wantedIndexes].filter((name) => !present.has(name));
}

/**
 * Does this clone's database match its schema?
 *
 * The check that earns the command. `data/*.db` is gitignored and `db/schema.sql`
 * is not, so a merge hands you tables you do not have; the clone then answers
 * 500 `no such table: oauth_tokens` on every call, which reads like a broken
 * server rather than a missing migration.
 */
export function schemaCheck(facts: SchemaFacts): Check {
  const title = `${facts.label} database`;
  const fix = `npm run db:init -w ${facts.workspace}   (every statement is CREATE … IF NOT EXISTS, so it keeps your data)`;

  if (!facts.schemaExists) {
    return {
      status: "fail",
      title,
      detail: `no schema at ${facts.schemaPath} — this is not a complete checkout`,
      fix: "git checkout the missing file, or re-clone the repo",
    };
  }

  const absent = facts.databases.filter((db) => !db.exists);
  if (absent.length === facts.databases.length) {
    return {
      status: "fail",
      title,
      detail: `no databases in this clone yet (${absent.map((d) => d.file).join(", ")})`,
      fix,
    };
  }

  const unreadable = facts.databases.filter((db) => db.exists && db.objects === null);
  if (unreadable.length > 0) {
    const first = unreadable[0];
    return {
      status: "fail",
      title,
      detail: `${first?.file} could not be read: ${first?.error ?? "unknown error"}`,
      fix: `delete it and rebuild: rm ${facts.workspace}/data/${first?.file} && ${fix}`,
    };
  }

  const behind = facts.databases
    .map((db) => ({ db, missing: missingObjects(facts.declared, db, facts.auditTables) }))
    .filter((row) => !row.db.exists || row.missing.length > 0);

  if (behind.length > 0) {
    const detail = behind
      .map(({ db, missing }) =>
        !db.exists
          ? `${db.file} is missing entirely`
          : `${db.file} is missing ${missing.length} of ${
              db.expects === "audit" ? "the audit" : "the schema's"
            } objects: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}`,
      )
      .join("; ");
    return {
      status: "fail",
      title,
      detail: `behind ${facts.schemaPath} — ${detail}`,
      fix,
      note:
        "this is what the OAuth merge did to Gmail: three new tables in schema.sql, none of them " +
        "in the .db, and every call answering 500 `no such table: oauth_tokens`",
    };
  }

  return {
    status: "ok",
    title,
    detail: `working.db, snapshot.db and audit.db all match ${facts.schemaPath}`,
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface Summary {
  failures: number;
  warnings: number;
  /** Nothing is broken. Warnings are allowed: not-started is not broken. */
  ready: boolean;
  lines: string[];
}

export function summarize(checks: Check[]): Summary {
  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (failures > 0) {
    return {
      failures,
      warnings,
      ready: false,
      lines: [
        `${plural(failures, "problem")}${warnings > 0 ? `, ${plural(warnings, "warning")}` : ""}.`,
        "Run the fixes above in order, then `sonata doctor` again.",
      ],
    };
  }
  if (warnings > 0) {
    return {
      failures,
      warnings,
      ready: true,
      lines: [
        `Nothing is broken. ${plural(warnings, "warning")} above — each says what it costs.`,
        "Start everything with `sonata up`.",
      ],
    };
  }
  return {
    failures,
    warnings,
    ready: true,
    lines: ["Everything checks out.", "`sonata up` starts the four apps; `sonata status` shows the work."],
  };
}
