import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeEmptyDb, makeSeededDb, NOW } from "./helpers";
import { listActions, logAction, startNewSession } from "@/lib/audit";
import { resolveObject, resolveStatus } from "@/lib/store/objects";
import { getMemberByEmail } from "@/lib/store/members";
import { allValuesFor } from "@/lib/store/records";
import { OBJ_DEALS, SEED_DEAL_NORTHWIND, ATTR_DE_STAGE } from "@/lib/seed";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

describe("schema", () => {
  it("creates every table the API reads", () => {
    const db = makeEmptyDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const table of [
      "meta",
      "workspace_members",
      "objects",
      "attributes",
      "statuses",
      "records",
      "attribute_values",
      "notes",
      "tasks",
      "task_linked_records",
      "task_assignees",
      "sessions",
      "action_log",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("indexes the hot value read — every shaped record depends on it", () => {
    const db = makeSeededDb();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM attribute_values
          WHERE record_id = ? AND attribute_id = ? AND active_until_ms IS NULL`,
      )
      .all(SEED_DEAL_NORTHWIND, ATTR_DE_STAGE) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_values_record_active");
  });

  it("cascades values when a record is removed", () => {
    const db = makeSeededDb();
    expect(allValuesFor(db, SEED_DEAL_NORTHWIND).length).toBeGreaterThan(0);
    db.prepare("DELETE FROM records WHERE id = ?").run(SEED_DEAL_NORTHWIND);
    expect(allValuesFor(db, SEED_DEAL_NORTHWIND)).toHaveLength(0);
  });

  it("cascades a task's links and assignees when the task is removed", () => {
    const db = makeSeededDb();
    const taskId = (db.prepare("SELECT id FROM tasks LIMIT 1").get() as { id: string }).id;
    const count = (table: string) =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(taskId) as {
          n: number;
        }
      ).n;
    expect(count("task_linked_records")).toBe(1);
    expect(count("task_assignees")).toBe(1);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    expect(count("task_linked_records")).toBe(0);
    expect(count("task_assignees")).toBe(0);
  });

  it("applies cleanly to a fresh audit-only database", () => {
    const audit = new Database(":memory:");
    audit.exec(schema);
    const names = (
      audit.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("action_log");
  });
});

describe("store", () => {
  it("resolves an object by slug and by id, and nothing else", () => {
    const db = makeSeededDb();
    expect(resolveObject(db, "deals")?.id).toBe(OBJ_DEALS);
    expect(resolveObject(db, OBJ_DEALS)?.api_slug).toBe("deals");
    expect(resolveObject(db, "invoices")).toBeNull();
  });

  it("resolves a status by title and by id", () => {
    const db = makeSeededDb();
    const byTitle = resolveStatus(db, ATTR_DE_STAGE, "In Progress");
    expect(byTitle?.title).toBe("In Progress");
    expect(resolveStatus(db, ATTR_DE_STAGE, byTitle!.id)?.title).toBe("In Progress");
    expect(resolveStatus(db, ATTR_DE_STAGE, "Nope")).toBeNull();
  });

  it("matches a workspace member's email case-insensitively", () => {
    const db = makeSeededDb();
    expect(getMemberByEmail(db, "SANDBOX.USER@GMAIL.COM")?.first_name).toBe("Sandbox");
    expect(getMemberByEmail(db, "nobody@acme.co")).toBeNull();
  });
});

describe("audit", () => {
  it("leaves no action row behind when the mutation rolls back", () => {
    const db = makeSeededDb();
    startNewSession(db, "test", NOW);
    expect(() =>
      db.transaction(() => {
        logAction(db, {
          method: "PATCH",
          endpoint: "/v2/objects/deals/records/x",
          actionType: "recordUpdate",
          targetType: "record",
          targetId: "x",
          summary: "Moved “X” stage: Lead → Won 🎉",
        });
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(listActions(db)).toHaveLength(0);
  });

  it("keeps the action when the transaction commits", () => {
    const db = makeSeededDb();
    startNewSession(db, "test", NOW);
    db.transaction(() => {
      logAction(db, {
        method: "POST",
        endpoint: "/v2/notes",
        actionType: "noteCreate",
        targetType: "note",
        targetId: "n1",
        summary: "Logged note “Escalation” on company “Northwind”",
      });
    })();
    const actions = listActions(db);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("noteCreate");
  });
});
