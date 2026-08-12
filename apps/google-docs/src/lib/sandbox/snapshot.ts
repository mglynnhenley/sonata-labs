import type { Database } from "better-sqlite3";
import { HEADING_STYLE_TYPES } from "../docs/defaults";
import { layout } from "../docs/index-space";
import { plainText } from "../docs/shape";
import { listDocumentRows, loadDocument } from "../store/documents";
import type { DocsTwinSnapshot } from "./types";

// The workspace as the judge sees it. Taken either side of the agent and diffed;
// both snapshots ship inside the run artifact, so this is capped rather than
// dumped.
//
// Unlike the Gmail twin's, it is built straight from the store rather than back
// out over HTTP: this clone's provider gate is a static token and the snapshot is
// a pure projection, so a round trip through the API would only add a failure
// mode without adding a check.

/** A workspace larger than this is a scenario bug, not a bigger scenario. */
const MAX_DOCUMENTS = 25;

/**
 * The graded question for a docs twin is literally what the document says, so
 * unlike Gmail's digest the text itself has to be here. But a workspace of
 * 4000-character documents is a scenario and a workspace of 400KB ones is a bug,
 * so it is capped and flagged rather than trusted.
 */
const MAX_TEXT_CHARS = 4000;

export function captureTwinSnapshot(db: Database): DocsTwinSnapshot {
  const rows = listDocumentRows(db).slice(0, MAX_DOCUMENTS);
  return {
    twin: "google-docs",
    documents: rows.flatMap((row) => {
      const model = loadDocument(db, row.id);
      if (!model) return [];
      const text = plainText(model);
      return [
        {
          documentId: model.documentId,
          title: model.title,
          revisionId: model.revisionId,
          headings: model.paragraphs
            .filter((p) => HEADING_STYLE_TYPES.includes(p.namedStyleType))
            .map((p) => p.runs.map((r) => r.content).join("").trimEnd()),
          paragraphCount: model.paragraphs.length,
          // The section break is excluded: this is the body text an editor shows.
          characterCount: layout(model).endIndex - 1,
          namedRanges: model.namedRanges.map((r) => r.name),
          isSandboxCreated: row.is_sandbox_created === 1,
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS,
        },
      ];
    }),
  };
}
