import type { Database } from "better-sqlite3";
import { canonicalStyleJson, blankParagraph } from "../docs/index-space";
import { newDocumentId, newRevisionId } from "../docs/ids";
import {
  type DocModel,
  type DocumentRow,
  type NamedRangeRow,
  type ParagraphModel,
  type ParagraphRow,
  type TextRunRow,
  toModel,
} from "../docs/shape";

// Raw-SQL data access for documents, their paragraphs, their runs and their
// named ranges. Every function takes `db` first so the whole layer is testable
// against an in-memory database; inputs are camelCase and columns are snake_case.

export function countDocuments(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
}

export function countParagraphs(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM paragraphs").get() as { n: number }).n;
}

/**
 * Newest-edited first — the order the landing page and the snapshot both want.
 * A whole seeded workspace is written at one instant, so `updated_ms` alone
 * leaves every document tied and the order down to whatever SQLite feels like
 * returning; `created_ms` breaks the tie with the world's own authoring dates.
 */
export function listDocumentRows(db: Database): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents ORDER BY updated_ms DESC, created_ms DESC")
    .all() as DocumentRow[];
}

export function getDocumentRow(db: Database, id: string): DocumentRow | null {
  return (db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow) ?? null;
}

/** The whole document as one model: three ordered reads through `toModel`. */
export function loadDocument(db: Database, id: string): DocModel | null {
  const doc = getDocumentRow(db, id);
  if (!doc) return null;
  const paragraphs = db
    .prepare("SELECT * FROM paragraphs WHERE document_id = ? ORDER BY para_index")
    .all(id) as ParagraphRow[];
  const runs = db
    .prepare("SELECT * FROM text_runs WHERE document_id = ? ORDER BY para_index, run_index")
    .all(id) as TextRunRow[];
  const ranges = db
    .prepare("SELECT * FROM named_ranges WHERE document_id = ? ORDER BY start_index")
    .all(id) as NamedRangeRow[];
  return toModel(doc, paragraphs, runs, ranges);
}

/**
 * Persist a model. Synchronous and called INSIDE the caller's transaction.
 *
 * The paragraph, run and named-range rows are rewritten wholesale rather than
 * patched row by row. A document is tens of paragraphs, and row-level surgery for
 * every index shift would be a second implementation of the index arithmetic —
 * one that would drift from index-space.ts the first time either changed.
 */
export function saveDocument(db: Database, model: DocModel, updatedMs: number): void {
  clearContent(db, model.documentId);
  writeContent(db, model.documentId, model.paragraphs);
  for (const range of model.namedRanges) {
    db.prepare(
      "INSERT INTO named_ranges (id, document_id, name, start_index, end_index) VALUES (?, ?, ?, ?, ?)",
    ).run(range.id, model.documentId, range.name, range.startIndex, range.endIndex);
  }
  db.prepare("UPDATE documents SET title = ?, revision_id = ?, updated_ms = ? WHERE id = ?").run(
    model.title,
    model.revisionId,
    updatedMs,
    model.documentId,
  );
}

function clearContent(db: Database, documentId: string): void {
  db.prepare("DELETE FROM named_ranges WHERE document_id = ?").run(documentId);
  db.prepare("DELETE FROM text_runs WHERE document_id = ?").run(documentId);
  db.prepare("DELETE FROM paragraphs WHERE document_id = ?").run(documentId);
}

function writeContent(db: Database, documentId: string, paragraphs: ParagraphModel[]): void {
  const insertParagraph = db.prepare(
    `INSERT INTO paragraphs (document_id, para_index, named_style_type, heading_id, alignment)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRun = db.prepare(
    `INSERT INTO text_runs (document_id, para_index, run_index, content, style_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  paragraphs.forEach((p, paraIndex) => {
    insertParagraph.run(
      documentId,
      paraIndex,
      p.namedStyleType,
      p.headingId,
      p.alignment,
    );
    p.runs.forEach((run, runIndex) => {
      // Canonical on the way in so two runs that look the same to normalise also
      // compare equal after a round trip through SQLite.
      insertRun.run(documentId, paraIndex, runIndex, run.content, canonicalStyleJson(run.style));
    });
  });
}

export interface InsertDocumentInput {
  id?: string;
  title: string;
  /** Required: every document in a cloned business belongs to someone in its cast. */
  ownerEmail: string;
  revisionId?: string;
  /** Omitted means the blank-document shape: one NORMAL_TEXT paragraph holding "\n". */
  paragraphs?: ParagraphModel[];
  createdMs: number;
  updatedMs: number;
  isSandboxCreated?: boolean;
}

export function insertDocument(db: Database, input: InsertDocumentInput): DocumentRow {
  const id = input.id ?? newDocumentId();
  const revisionId = input.revisionId ?? newRevisionId();
  db.prepare(
    `INSERT INTO documents (id, title, revision_id, owner_email, created_ms, updated_ms, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    revisionId,
    input.ownerEmail,
    input.createdMs,
    input.updatedMs,
    input.isSandboxCreated ? 1 : 0,
  );
  writeContent(db, id, input.paragraphs?.length ? input.paragraphs : [blankParagraph()]);
  return getDocumentRow(db, id) as DocumentRow;
}

/** Wipe every document and everything hanging off one. Used by the total seed. */
export function deleteAllDocuments(db: Database): void {
  db.prepare("DELETE FROM named_ranges").run();
  db.prepare("DELETE FROM text_runs").run();
  db.prepare("DELETE FROM paragraphs").run();
  db.prepare("DELETE FROM documents").run();
}
