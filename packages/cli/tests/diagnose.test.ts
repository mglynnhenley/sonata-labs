import { describe, expect, it } from "vitest";
import {
  apiKeyCheck,
  classifyPort,
  dependencyCheck,
  envFileCheck,
  missingObjects,
  nodeCheck,
  parseEngineFloor,
  parseEnvKeys,
  parseSchema,
  portCheck,
  schemaCheck,
  summarize,
  type Check,
  type DatabaseObservation,
  type EnvFile,
  type KeyFacts,
  type SchemaFacts,
} from "../src/diagnose";

// The diagnosis, with the machine faked: every input here is what a socket, a
// file or sqlite would have said. What is being tested is the sentence that
// comes out — specifically that a check which is not `ok` names the command
// that clears it, because a doctor that only reports is a doctor nobody runs
// twice.

function fixText(check: Check): string {
  return check.status === "ok" ? "" : check.fix;
}

describe("nodeCheck", () => {
  it("fails a Node below the floor and names the upgrade", () => {
    const check = nodeCheck("v18.20.4", { major: 22, minor: 0 });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("18.20.4");
    expect(fixText(check)).toContain("nvm install 22");
  });

  it("passes at the floor exactly", () => {
    expect(nodeCheck("v20.12.0", { major: 20, minor: 12 }).status).toBe("ok");
    expect(nodeCheck("v20.11.1", { major: 20, minor: 12 }).status).toBe("fail");
  });

  it("takes the floor from the repo's own engines field", () => {
    expect(parseEngineFloor(">=22.0.0")).toEqual({ major: 22, minor: 0 });
    expect(parseEngineFloor(">=20.12")).toEqual({ major: 20, minor: 12 });
    expect(parseEngineFloor("^22")).toEqual({ major: 22, minor: 0 });
    expect(parseEngineFloor(undefined)).toBeNull();
    expect(parseEngineFloor("latest")).toBeNull();
  });
});

describe("dependencyCheck", () => {
  const base = { installed: true, missingLinks: [], sqlite: "ok", installCommand: "npm install" };

  it("sends an empty checkout to npm install", () => {
    const check = dependencyCheck({ ...base, installed: false });
    expect(check.status).toBe("fail");
    expect(fixText(check)).toBe("npm install");
  });

  it("names the workspaces that are not linked", () => {
    const check = dependencyCheck({ ...base, missingLinks: ["@sonata/core"] });
    expect(check.detail).toContain("@sonata/core");
    expect(fixText(check)).toBe("npm install");
  });

  it("sends a native module built for another Node to rebuild, not install", () => {
    const check = dependencyCheck({ ...base, sqlite: "NODE_MODULE_VERSION 115 vs 127" });
    expect(check.status).toBe("fail");
    expect(fixText(check)).toContain("npm rebuild better-sqlite3");
  });

  it("is quiet when everything is there", () => {
    expect(dependencyCheck(base).status).toBe("ok");
  });
});

describe("parseEnvKeys", () => {
  it("reads the shapes people actually type", () => {
    const keys = parseEnvKeys(
      ["# a comment", "OPENROUTER_API_KEY=sk-or-abc", 'export PORT="3101"', "EMPTY=", "  SPACED = 7 "].join("\n"),
    );
    expect(keys.get("OPENROUTER_API_KEY")).toBe("sk-or-abc");
    expect(keys.get("PORT")).toBe("3101");
    expect(keys.get("EMPTY")).toBe("");
    expect(keys.get("SPACED")).toBe("7");
  });

  it("ignores commented-out settings", () => {
    expect(parseEnvKeys("# OPENROUTER_API_KEY=sk-or-old").has("OPENROUTER_API_KEY")).toBe(false);
  });
});

function envFile(pathName: string, entries: Record<string, string> | null): EnvFile {
  return {
    path: pathName,
    exists: entries !== null,
    keys: new Map(Object.entries(entries ?? {})),
  };
}

function keyFacts(files: EnvFile[], extra: Partial<KeyFacts> = {}): KeyFacts {
  return { files, inShell: false, inSettings: false, envPath: ".env", ...extra };
}

describe("envFileCheck", () => {
  it("offers init when there is no .env anywhere", () => {
    const check = envFileCheck(keyFacts([envFile(".env", null), envFile("apps/gmail/.env", null)]));
    expect(check.status).toBe("warn");
    expect(fixText(check)).toContain("sonata init");
  });

  it("lists the files it found", () => {
    const check = envFileCheck(keyFacts([envFile(".env", {}), envFile("apps/gmail/.env", null)]));
    expect(check.status).toBe("ok");
    expect(check.detail).toContain(".env");
  });
});

describe("apiKeyCheck", () => {
  it("accepts the key from the file that sets it", () => {
    const check = apiKeyCheck(keyFacts([envFile(".env", { OPENROUTER_API_KEY: "sk-or-1" })]));
    expect(check.status).toBe("ok");
    expect(check.detail).toContain(".env");
  });

  it("accepts a key that only exists in Settings", () => {
    const check = apiKeyCheck(keyFacts([envFile(".env", {})], { inSettings: true }));
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("Settings");
  });

  // The failure this repo has actually shipped: the key is there, under a name
  // nothing reads, and every model call fails as if there were no key at all.
  it("fails a misspelt name and says which line to rename", () => {
    const check = apiKeyCheck(keyFacts([envFile(".env", { OPEN_ROUTER_KEY: "sk-or-1" })]));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("OPEN_ROUTER_KEY");
    expect(fixText(check)).toContain("OPENROUTER_API_KEY=");
  });

  it("notices a name that is right but empty", () => {
    const check = apiKeyCheck(keyFacts([envFile(".env", { OPENROUTER_API_KEY: "" })]));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("empty");
  });

  it("warns without a key and says what stays unavailable", () => {
    const check = apiKeyCheck(keyFacts([envFile(".env", {})]));
    expect(check.status).toBe("warn");
    expect(check.note).toContain("no judge");
    expect(fixText(check)).toContain("sonata init");
  });

  // `cp .env.example .env` is the documented first step and the second half of
  // that sentence — "then put a key in it" — is the half people skip. Called ok,
  // this is a green doctor followed by a run that dies on its first model call.
  it("does not mistake .env.example's placeholder for a key", () => {
    const check = apiKeyCheck(
      keyFacts([envFile(".env", { OPENROUTER_API_KEY: "sk-or-v1-..." })], {
        placeholder: "sk-or-v1-...",
      }),
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("placeholder");
    expect(fixText(check)).toContain("openrouter.ai/keys");
  });

  it("still accepts a real key when a placeholder is known", () => {
    const check = apiKeyCheck(
      keyFacts([envFile(".env", { OPENROUTER_API_KEY: "sk-or-v1-real" })], {
        placeholder: "sk-or-v1-...",
      }),
    );
    expect(check.status).toBe("ok");
  });
});

describe("classifyPort", () => {
  const answer = (status: number, body: unknown) => ({
    listening: true,
    health: { status, body: typeof body === "string" ? body : JSON.stringify(body) },
  });

  it("reads an empty port as free", () => {
    expect(classifyPort({ listening: false, health: null })).toEqual({ kind: "free" });
  });

  it("accepts either health shape the clones use", () => {
    expect(classifyPort(answer(200, { ok: true, messages: 2 }))).toEqual({
      kind: "sonata",
      detail: "2 messages",
    });
    expect(classifyPort(answer(200, { status: "ok", events: 3, calendars: 1 }))).toEqual({
      kind: "sonata",
      detail: "3 events · 1 calendars",
    });
  });

  // The whole point of the four-way split: this one is fixed by a migration,
  // and the one below it is fixed by killing a process.
  it("separates a clone answering an error from a stranger on the port", () => {
    const broken = classifyPort(answer(500, "Error: no such table: oauth_tokens"));
    expect(broken.kind).toBe("sonata-broken");
    expect(broken.kind === "sonata-broken" && broken.detail).toContain("no such table");

    expect(classifyPort(answer(404, "<!DOCTYPE html>")).kind).toBe("foreign");
    expect(classifyPort(answer(200, { hello: "world" })).kind).toBe("foreign");
    expect(classifyPort({ listening: true, health: null }).kind).toBe("foreign");
  });
});

describe("portCheck", () => {
  const ctx = { label: "Gmail", port: 3101, startCommand: "sonata up gmail" };

  it("treats not-running as a warning with the command to start it", () => {
    const check = portCheck({ ...ctx, state: { kind: "free" } });
    expect(check.status).toBe("warn");
    expect(fixText(check)).toBe("sonata up gmail");
  });

  it("treats a stranger on the port as a failure and says how to free it", () => {
    const check = portCheck({ ...ctx, state: { kind: "foreign", detail: "answered 404" } });
    expect(check.status).toBe("fail");
    expect(fixText(check)).toContain("lsof -ti tcp:3101");
  });

  it("passes a serving clone", () => {
    expect(portCheck({ ...ctx, state: { kind: "sonata", detail: "2 messages" } }).status).toBe("ok");
  });
});

describe("parseSchema", () => {
  it("takes every declared name, including virtual tables", () => {
    const declared = parseSchema(`
      -- CREATE TABLE commented_out (id TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (subject);
      CREATE TABLE "quoted" (id TEXT);
    `);
    expect(declared.tables).toEqual(["messages", "messages_fts", "quoted"]);
    expect(declared.indexes).toEqual(["idx_messages_id"]);
  });
});

function db(file: string, objects: string[] | null, expects: "full" | "audit" = "full"): DatabaseObservation {
  return { file, exists: objects !== null, objects, error: null, expects };
}

describe("missingObjects", () => {
  const declared = {
    tables: ["messages", "messages_fts", "sessions", "action_log"],
    indexes: ["idx_messages_id", "idx_action_log_session"],
  };
  const audit = ["sessions", "action_log"];

  it("ignores the shadow tables sqlite creates for an fts index", () => {
    const present = [
      "messages",
      "messages_fts",
      "messages_fts_data",
      "messages_fts_idx",
      "sessions",
      "action_log",
      "idx_messages_id",
      "idx_action_log_session",
    ];
    expect(missingObjects(declared, db("working.db", present), audit)).toEqual([]);
  });

  it("names what the schema declares and the file has not got", () => {
    expect(missingObjects(declared, db("working.db", ["messages", "sessions"]), audit)).toEqual([
      "messages_fts",
      "action_log",
      "idx_messages_id",
      "idx_action_log_session",
    ]);
  });

  it("asks an audit file only for the audit tables", () => {
    expect(missingObjects(declared, db("audit.db", ["sessions", "action_log", "idx_action_log_session"], "audit"), audit)).toEqual(
      [],
    );
  });
});

function schemaFactsFor(databases: DatabaseObservation[]): SchemaFacts {
  return {
    label: "Gmail",
    workspace: "apps/gmail",
    schemaPath: "apps/gmail/db/schema.sql",
    schemaExists: true,
    declared: { tables: ["messages", "oauth_tokens"], indexes: [] },
    auditTables: ["sessions", "action_log"],
    databases,
  };
}

describe("schemaCheck", () => {
  it("passes when every file carries what the schema declares", () => {
    const check = schemaCheck(
      schemaFactsFor([db("working.db", ["messages", "oauth_tokens"]), db("snapshot.db", ["messages", "oauth_tokens"])]),
    );
    expect(check.status).toBe("ok");
  });

  // The failure the command exists for: schema.sql arrives through git, the
  // .db files do not, and the clone 500s on every call until db:init is run.
  it("names the missing tables and the one command that adds them", () => {
    const check = schemaCheck(schemaFactsFor([db("working.db", ["messages"]), db("snapshot.db", ["messages"])]));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("oauth_tokens");
    expect(fixText(check)).toContain("npm run db:init -w apps/gmail");
  });

  it("reports a clone with no databases at all", () => {
    const check = schemaCheck(schemaFactsFor([db("working.db", null), db("snapshot.db", null)]));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("no databases");
    expect(fixText(check)).toContain("db:init");
  });

  it("reports an unreadable file as itself, not as a missing table", () => {
    const facts = schemaFactsFor([{ file: "working.db", exists: true, objects: null, error: "file is not a database", expects: "full" }]);
    const check = schemaCheck(facts);
    expect(check.detail).toContain("file is not a database");
    expect(fixText(check)).toContain("rm apps/gmail/data/working.db");
  });

  it("says so when the schema itself is missing", () => {
    const check = schemaCheck({ ...schemaFactsFor([db("working.db", ["messages"])]), schemaExists: false });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not a complete checkout");
  });
});

describe("summarize", () => {
  const ok: Check = { status: "ok", title: "Node", detail: "fine" };
  const warn: Check = { status: "warn", title: "Gmail :3101", detail: "not running", fix: "sonata up" };
  const fail: Check = { status: "fail", title: "Gmail database", detail: "behind", fix: "db:init" };

  it("calls a warning-only install ready", () => {
    const summary = summarize([ok, warn]);
    expect(summary).toMatchObject({ failures: 0, warnings: 1, ready: true });
    expect(summary.lines.join(" ")).toContain("sonata up");
  });

  it("counts failures and sends the reader back", () => {
    const summary = summarize([ok, warn, fail]);
    expect(summary).toMatchObject({ failures: 1, warnings: 1, ready: false });
    expect(summary.lines.join(" ")).toContain("sonata doctor");
  });

  it("has something to say when everything passes", () => {
    expect(summarize([ok]).lines.join(" ")).toContain("Everything checks out");
  });
});
