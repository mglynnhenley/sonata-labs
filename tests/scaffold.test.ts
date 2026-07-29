import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

// Sanity: schema.sql applies cleanly to an in-memory DB and creates the core
// tables. Guards against SQL syntax regressions in the single source of truth.
describe("schema", () => {
  const schema = readFileSync(
    path.resolve(__dirname, "..", "db", "schema.sql"),
    "utf8",
  );

  it("applies to a fresh database", () => {
    const db = new Database(":memory:");
    expect(() => db.exec(schema)).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of [
      "meta",
      "labels",
      "messages",
      "message_labels",
      "attachments",
      "drafts",
      "outbox",
      "sessions",
      "action_log",
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("provides FTS5 search over messages", () => {
    const db = new Database(":memory:");
    db.exec(schema);
    db.prepare(
      "INSERT INTO messages_fts (message_id, subject, from_addr, to_addrs, body) VALUES (?, ?, ?, ?, ?)",
    ).run("m1", "Quarterly report", "cfo@corp.com", "me@me.com", "revenue up");
    const hit = db
      .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?")
      .get("revenue") as { message_id: string } | undefined;
    expect(hit?.message_id).toBe("m1");
    db.close();
  });
});
