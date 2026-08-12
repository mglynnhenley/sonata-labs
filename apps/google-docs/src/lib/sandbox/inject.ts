import type { Database } from "better-sqlite3";
import { insertText, replaceAllText, updateParagraphStyle } from "../docs/edit";
import { newDocumentId, newRevisionId, seededRevisionId } from "../docs/ids";
import { layout } from "../docs/index-space";
import type { DocModel } from "../docs/shape";
import { insertDocument, loadDocument, saveDocument } from "../store/documents";
import { getOwnerEmail } from "../store/meta";
import { BadRequestError } from "./auth";
import {
  array,
  flag,
  object,
  optionalArray,
  optionalText,
  parseWireParagraphs,
  text,
  toParagraphModels,
} from "./parse";
import type { InjectRequest, InjectResult, ParsedParagraph } from "./types";

// The director's hand on the workspace: a colleague shares a new brief, or
// revises the section the agent is working in.
//
// Deliberately NOT audit-logged — injection is scenario setup, not agent
// behaviour, and the judge reads the audit log to score the agent. Getting this
// backwards scores the world's own moves as the agent's work. Injected documents
// carry is_sandbox_created = 0 so they are indistinguishable from seeded ones.
//
// Edits go through the same pure functions in docs/edit.ts that a batchUpdate
// does, so a beat can never produce a document the agent's own edits could not
// have produced. One consequence is worth stating: an appended paragraph inherits
// the run styling of the character before it, exactly as the vendor's insertText
// does, so `bold` on an injected append is not honoured. It is honoured on a
// seeded document, whose runs are written directly.

/**
 * Simulated time, never wall-clock. A document stamped with the real clock inside
 * a simulated Monday morning makes the whole day incoherent to the agent reading
 * it, so a beat with no time is a 400 rather than a silent Date.now().
 */
export function resolveInjectTime(body: InjectRequest, what: string): number {
  if (typeof body.atMs === "number" && Number.isFinite(body.atMs)) return body.atMs;
  if (typeof body.atISO === "string") {
    const ms = Date.parse(body.atISO);
    if (!Number.isNaN(ms)) return ms;
    throw new BadRequestError(`${what}: atISO must be an absolute ISO 8601 timestamp`);
  }
  throw new BadRequestError(`${what}: atMs or atISO is required`);
}

/** Play one beat. Called inside ONE `db.transaction` by the route. */
export function injectDocs(db: Database, body: unknown): InjectResult {
  const root = object(body, "body");
  const atMs = resolveInjectTime(root as InjectRequest, "inject");
  const documents = optionalArray(root, "documents", "body");
  const edits = optionalArray(root, "edits", "body");
  if (!documents.length && !edits.length) throw new BadRequestError("nothing to inject");

  const ownerEmail = getOwnerEmail(db);
  const result: InjectResult = { twin: "google-docs", documents: [], edits: [] };

  documents.forEach((entry, i) => {
    const where = `documents[${i}]`;
    const spec = object(entry, where);
    const id = optionalText(spec, "id", where) || newDocumentId();
    const revisionId = seededRevisionId(id, atMs);
    insertDocument(db, {
      id,
      title: text(spec, "title", where),
      ownerEmail: optionalText(spec, "ownerEmail", where) || ownerEmail,
      revisionId,
      paragraphs: toParagraphModels(
        parseWireParagraphs(array(spec, "paragraphs", where), `${where}.paragraphs`),
      ),
      createdMs: atMs,
      updatedMs: atMs,
      isSandboxCreated: false,
    });
    result.documents.push({
      // slotId is the engine's own handle for the document it asked for; without
      // one, the minted id is the handle.
      slotId: optionalText(spec, "slotId", where) || id,
      documentId: id,
      revisionId,
    });
  });

  edits.forEach((entry, i) => {
    const where = `edits[${i}]`;
    const spec = object(entry, where);
    const documentId = text(spec, "documentId", where);
    const model = loadDocument(db, documentId);
    if (!model) {
      throw new BadRequestError(
        `${where}.documentId "${documentId}" is not a document in this workspace`,
      );
    }

    const appended = optionalArray(spec, "appendParagraphs", where);
    if (appended.length) {
      for (const paragraph of parseWireParagraphs(appended, `${where}.appendParagraphs`)) {
        appendParagraph(model, i, paragraph);
      }
    }

    let occurrencesChanged = 0;
    optionalArray(spec, "replace", where).forEach((rule, r) => {
      const at = `${where}.replace[${r}]`;
      const replacement = object(rule, at);
      occurrencesChanged += replaceAllText(model, i, {
        containsText: {
          text: text(replacement, "find", at),
          matchCase: flag(replacement, "matchCase", at),
        },
        replaceText: optionalText(replacement, "replaceWith", at),
      });
    });

    const revisionId = newRevisionId();
    model.revisionId = revisionId;
    saveDocument(db, model, atMs);
    result.edits.push({ documentId, revisionId, occurrencesChanged });
  });

  return result;
}

/**
 * One new paragraph at the end of the body. The leading "\n" is what makes it a
 * new paragraph rather than a longer last one — endOfSegmentLocation lands
 * immediately before the body's final newline, so text inserted there joins the
 * paragraph already sitting in front of it.
 */
function appendParagraph(model: DocModel, n: number, paragraph: ParsedParagraph): void {
  const body = paragraph.runs
    .map((r) => r.content)
    .join("")
    .replace(/\n$/, "");
  insertText(model, n, { text: "\n" + body, endOfSegmentLocation: {} });
  // The new paragraph inherits the previous one's style, so the wire's own
  // namedStyleType is applied afterwards — the same two requests an agent would
  // send to append a heading.
  const l = layout(model);
  const last = l.paragraphs[l.paragraphs.length - 1];
  updateParagraphStyle(model, n, {
    range: { startIndex: last.startIndex, endIndex: last.startIndex },
    paragraphStyle: { namedStyleType: paragraph.namedStyleType },
    fields: "namedStyleType",
  });
}
