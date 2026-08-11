import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloneFiles } from "../src/apps";
import { schemaCheck } from "../src/diagnose";
import { schemaFacts } from "../src/probe";

// The one part of doctor that reads sqlite, against real sqlite. No process and
// no HTTP: a schema.sql and three files on disk, which is exactly the situation
// a pull leaves behind. It is here rather than in the pure tests because the
// question it settles — what sqlite_master actually contains after an fts5
// table is created — cannot be settled by a fixture someone wrote by hand.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, subject TEXT);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (subject);
CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
`;

const AUDIT_ONLY = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log (session_id, ts);
`;

let dir = "";
let clone: CloneFiles;

function write(file: string, sql: string): void {
  const db = new Database(file);
  db.exec(sql);
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sonata-cli-"));
  mkdirSync(path.join(dir, "db"));
  mkdirSync(path.join(dir, "data"));
  writeFileSync(path.join(dir, "db", "schema.sql"), SCHEMA);
  write(path.join(dir, "data", "working.db"), SCHEMA);
  // The clone that came back from a merge without its migration.
  write(path.join(dir, "data", "snapshot.db"), SCHEMA.replace(/CREATE TABLE IF NOT EXISTS oauth_tokens[^;]+;/, ""));
  write(path.join(dir, "data", "audit.db"), AUDIT_ONLY);

  clone = {
    schemaPath: path.join(dir, "db", "schema.sql"),
    dataDir: path.join(dir, "data"),
    workspace: "apps/gmail",
    databases: [
      { file: "working.db", path: path.join(dir, "data", "working.db"), expects: "full" },
      { file: "snapshot.db", path: path.join(dir, "data", "snapshot.db"), expects: "full" },
      { file: "audit.db", path: path.join(dir, "data", "audit.db"), expects: "audit" },
    ],
  };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schemaFacts against real databases", () => {
  it("finds the file that is behind, and leaves the fts shadow tables out of it", async () => {
    const check = schemaCheck(await schemaFacts("Gmail", clone));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("snapshot.db");
    expect(check.detail).toContain("oauth_tokens");
    // working.db has the same fts5 table the real clones do; if the shadow
    // tables confused the diff, this file would be reported as behind too.
    expect(check.detail).not.toContain("working.db");
    expect(check.status !== "ok" && check.fix).toContain("db:init");
  });

  it("passes an audit file holding only the two audit tables", async () => {
    const auditOnly: CloneFiles = { ...clone, databases: [clone.databases[2] as CloneFiles["databases"][number]] };
    expect(schemaCheck(await schemaFacts("Gmail", auditOnly)).status).toBe("ok");
  });

  it("reports a missing database rather than an empty one", async () => {
    const gone: CloneFiles = {
      ...clone,
      databases: [{ file: "working.db", path: path.join(dir, "data", "nope.db"), expects: "full" }],
    };
    const check = schemaCheck(await schemaFacts("Gmail", gone));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("no databases");
  });

  it("does not create the database it was asked about", async () => {
    const gone: CloneFiles = {
      ...clone,
      databases: [{ file: "working.db", path: path.join(dir, "data", "nope.db"), expects: "full" }],
    };
    await schemaFacts("Gmail", gone);
    expect(() => new Database(path.join(dir, "data", "nope.db"), { fileMustExist: true })).toThrow();
  });
});
