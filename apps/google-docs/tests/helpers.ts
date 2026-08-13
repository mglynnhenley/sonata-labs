import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_DDL } from "@/lib/db";
import { HEADING_STYLE_TYPES } from "@/lib/docs/defaults";
import type { DocModel, ParagraphModel } from "@/lib/docs/shape";
import { insertDocument } from "@/lib/store/documents";
import { setMeta } from "@/lib/store/meta";

// The real document schema, off disk, so a schema regression fails the suite
// rather than being papered over by a hand-written CREATE TABLE that drifted
// from it. Exported because one test is about what this file must NOT create.
export const DOCUMENT_SCHEMA = readFileSync(
  path.resolve(__dirname, "..", "db", "schema.sql"),
  "utf8",
);

export const OWNER = "sandbox.user@gmail.com";
/** Monday 2026-07-27, 09:00 America/New_York — the week every twin's seed uses. */
export const ANCHOR_MS = Date.UTC(2026, 6, 27, 13, 0, 0);

export interface TestRun {
  content: string;
  bold?: boolean;
}

export interface TestParagraph {
  style?: string;
  text?: string;
  runs?: TestRun[];
}

export interface TestDoc {
  id: string;
  title: string;
  paragraphs: TestParagraph[];
}

/** One paragraph model, with the trailing "\n" the index space requires. */
function toParagraph(p: TestParagraph): ParagraphModel {
  const style = p.style ?? "NORMAL_TEXT";
  const runs = (p.runs ?? [{ content: p.text ?? "" }]).map((run) => ({
    content: run.content,
    style: run.bold ? ({ bold: true } as Record<string, unknown>) : null,
  }));
  runs[runs.length - 1] = {
    ...runs[runs.length - 1],
    content: runs[runs.length - 1].content + "\n",
  };
  return {
    namedStyleType: style,
    headingId: HEADING_STYLE_TYPES.includes(style) ? `h.${style.toLowerCase()}00` : null,
    alignment: null,
    runs,
  };
}

/** A bare model with no database, for the pure index-space and edit suites. */
export function makeModel(paragraphs: TestParagraph[]): DocModel {
  return {
    documentId: "1TestDocument000000000000000000000000000000",
    title: "Test document",
    revisionId: "rev0",
    paragraphs: paragraphs.map(toParagraph),
    namedRanges: [],
  };
}

export function makeTestDb(docs: TestDoc[] = []): Database.Database {
  const db = new Database(":memory:");
  db.exec(DOCUMENT_SCHEMA);
  // Mirror production's ATTACHed audit.db so mutation code paths that log can
  // run unchanged under test.
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);
  setMeta(db, "owner_email", OWNER);
  setMeta(db, "owner_name", "Sandbox User");

  for (const doc of docs) {
    // Through the real insertDocument, never raw SQL: a fixture written by hand
    // would be the one document in the suite that the store never wrote.
    insertDocument(db, {
      id: doc.id,
      title: doc.title,
      ownerEmail: OWNER,
      paragraphs: doc.paragraphs.map(toParagraph),
      createdMs: ANCHOR_MS,
      updatedMs: ANCHOR_MS,
    });
  }
  return db;
}

/** One document reused across the suites, in the shape a real one has. */
export const CORPUS: TestDoc[] = [
  {
    id: "1CorpusDocument00000000000000000000000000Ab",
    title: "Q3 Business Review — draft",
    paragraphs: [
      { style: "TITLE", text: "Q3 Business Review — draft" },
      {
        runs: [
          { content: "Since Thursday " },
          { content: "payments have been failing", bold: true },
          { content: " for Northwind." },
        ],
      },
      { style: "HEADING_1", text: "Headcount" },
      { text: "We carry [[HEADCOUNT]] roles, and [[HEADCOUNT]] are backfills." },
      { text: "Ship it 😄" },
    ],
  },
];
