import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { logAction } from "@/lib/audit";
import { AUDIT_DDL } from "@/lib/db";
import { layout } from "@/lib/docs/index-space";
import type { DocModel } from "@/lib/docs/shape";
import {
  countDocuments,
  countParagraphs,
  insertDocument,
  loadDocument,
  saveDocument,
} from "@/lib/store/documents";
import { CORPUS, makeTestDb, makeModel } from "./helpers";

// The scaffold suite: the schema the API depends on, the store round trip, and
// the audit invariant every mutation rests on.

describe("schema", () => {
  const db = makeTestDb(CORPUS);

  it("has every table the API reads", () => {
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    for (const table of ["meta", "documents", "paragraphs", "text_runs", "named_ranges"]) {
      expect(names.has(table)).toBe(true);
    }
    const auditNames = new Set(
      (db.prepare("SELECT name FROM audit.sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    expect(auditNames.has("sessions")).toBe(true);
    expect(auditNames.has("action_log")).toBe(true);
  });

  it("reads text_runs through idx_text_runs_document — every document read depends on it", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM text_runs WHERE document_id = ? ORDER BY para_index, run_index",
      )
      .all("x") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_text_runs_document");
  });

  it("cascades a document delete to its paragraphs, runs and named ranges", () => {
    const scratch = makeTestDb(CORPUS);
    scratch.pragma("foreign_keys = ON");
    scratch
      .prepare("INSERT INTO named_ranges (id, document_id, name, start_index, end_index) VALUES (?, ?, ?, ?, ?)")
      .run("kix.aaaaaaaaaaaa", CORPUS[0].id, "n", 1, 3);
    scratch.prepare("DELETE FROM documents WHERE id = ?").run(CORPUS[0].id);
    for (const table of ["paragraphs", "text_runs", "named_ranges"]) {
      const n = (scratch.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
  });

  it("applies cleanly to a fresh audit-only in-memory database", () => {
    const fresh = new Database(":memory:");
    fresh.prepare("ATTACH DATABASE ':memory:' AS audit").run();
    expect(() => fresh.exec(AUDIT_DDL)).not.toThrow();
  });
});

describe("store", () => {
  it("round-trips a saved model exactly", () => {
    const db = makeTestDb(CORPUS);
    const model = loadDocument(db, CORPUS[0].id)!;
    model.paragraphs[0].alignment = "CENTER";
    model.paragraphs[0].extra = { spaceAbove: { magnitude: 12, unit: "PT" } };
    model.namedRanges = [{ id: "kix.aaaaaaaaaaaa", name: "n", startIndex: 1, endIndex: 4 }];
    saveDocument(db, model, 1);
    expect(loadDocument(db, CORPUS[0].id)).toEqual(model);
  });

  it("mints a Google-shaped id and a revision id when none is supplied", () => {
    const db = makeTestDb();
    const row = insertDocument(db, { title: "Untitled document", createdMs: 1, updatedMs: 1 });
    expect(row.id).toMatch(/^1[A-Za-z0-9_-]{43}$/);
    expect(row.revision_id.length).toBeGreaterThan(0);
  });

  it("writes the blank-document shape when no paragraphs are given", () => {
    const db = makeTestDb();
    const row = insertDocument(db, { title: "Blank", createdMs: 1, updatedMs: 1 });
    const model = loadDocument(db, row.id)!;
    expect(model.paragraphs).toHaveLength(1);
    expect(model.paragraphs[0].runs).toEqual([{ content: "\n", style: null }]);
    expect(layout(model).endIndex).toBe(2);
  });

  it("counts what the health route reports", () => {
    const db = makeTestDb(CORPUS);
    expect(countDocuments(db)).toBe(1);
    expect(countParagraphs(db)).toBe(CORPUS[0].paragraphs.length);
  });
});

describe("audit", () => {
  const entry = {
    method: "POST",
    endpoint: "/v1/documents/x:batchUpdate",
    actionType: "documentBatchUpdate",
    targetType: "document",
    targetId: "x",
    responseCode: 200,
    summary: "Applied 1 request(s)",
  };
  const rowCount = (db: Database.Database): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM audit.action_log").get() as { n: number }).n;

  it("leaves no row when the transaction it was written in throws", () => {
    const db = makeTestDb(CORPUS);
    const tx = db.transaction(() => {
      logAction(db, entry);
      throw new Error("the second request was invalid");
    });
    expect(() => tx()).toThrow("the second request was invalid");
    // The absence is the design: a failed batch changes nothing, including the
    // trail the judge reads.
    expect(rowCount(db)).toBe(0);
  });

  it("leaves exactly one row when it commits", () => {
    const db = makeTestDb(CORPUS);
    db.transaction(() => logAction(db, entry))();
    expect(rowCount(db)).toBe(1);
    const row = db.prepare("SELECT * FROM audit.action_log").get() as { action_type: string };
    expect(row.action_type).toBe("documentBatchUpdate");
  });
});

describe("model fixtures", () => {
  it("makeModel produces a document whose paragraphs already tile the index space", () => {
    const model: DocModel = makeModel([{ text: "a" }, { text: "b" }]);
    const l = layout(model);
    expect(l.paragraphs.map((p) => [p.startIndex, p.endIndex])).toEqual([
      [1, 3],
      [3, 5],
    ]);
  });
});
