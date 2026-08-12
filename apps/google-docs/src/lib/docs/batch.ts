import { badRequestError, DocsError } from "./errors";
import {
  createNamedRange,
  type CreateNamedRangeRequest,
  deleteContentRange,
  type DeleteContentRangeRequest,
  insertText,
  type InsertTextRequest,
  replaceAllText,
  type ReplaceAllTextRequest,
  updateParagraphStyle,
  type UpdateParagraphStyleRequest,
} from "./edit";
import type { DocModel } from "./shape";

// The batchUpdate dispatcher: validate, apply in order, collect replies.
//
// batchUpdate is atomic in the real API — if any request is invalid the whole
// batch fails and nothing is applied. Here that falls out of applying requests in
// order inside one better-sqlite3 transaction: a throw rolls the document AND its
// audit row back together, so a failed batch leaves no trace anywhere.

/** The Request members this sandbox recognises, in the order they are documented. */
const REQUEST_KEYS = [
  "insertText",
  "deleteContentRange",
  "replaceAllText",
  "updateParagraphStyle",
  "createNamedRange",
  "insertTable",
] as const;

type RequestKey = (typeof REQUEST_KEYS)[number];

export interface BatchRequest {
  [key: string]: unknown;
}

export interface WriteControl {
  requiredRevisionId?: unknown;
}

/**
 * Reject a stale write before anything is applied. The vendor's optimistic
 * concurrency check: an agent that read a document, thought about it, and came
 * back to write must not clobber an edit a colleague made in between.
 */
export function checkWriteControl(model: DocModel, writeControl?: WriteControl): void {
  const required = writeControl?.requiredRevisionId;
  if (typeof required !== "string" || !required) return;
  if (required !== model.revisionId) {
    throw new DocsError(
      400,
      "The provided required revision ID does not match the current revision of the document.",
      "FAILED_PRECONDITION",
    );
  }
}

/** Apply every request in order, returning one reply per request. */
export function applyBatchUpdate(model: DocModel, requests: unknown): { replies: unknown[] } {
  if (!Array.isArray(requests)) {
    throw badRequestError("Invalid requests: must be an array of Request objects.");
  }

  const replies: unknown[] = [];
  requests.forEach((entry, n) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw badRequestError(`Invalid requests[${n}]: a request field must be set.`);
    }
    const request = entry as BatchRequest;
    const keys = Object.keys(request).filter((k) => request[k] !== undefined);

    // The unknown-name check comes first because it is the proto-JSON parser's,
    // and the parser runs before the oneof is ever looked at: `{insertText, typo}`
    // fails on the typo, not on the union.
    const unknown = keys.find((k) => !(REQUEST_KEYS as readonly string[]).includes(k));
    if (unknown) {
      throw badRequestError(
        `Invalid JSON payload received. Unknown name "${unknown}" at 'requests[${n}]': Cannot find field.`,
      );
    }
    if (keys.length === 0) {
      throw badRequestError(`Invalid requests[${n}]: a request field must be set.`);
    }
    if (keys.length > 1) {
      throw badRequestError(`Invalid requests[${n}]: exactly one request field may be set.`);
    }

    replies.push(apply(model, n, keys[0] as RequestKey, request[keys[0]]));
  });

  return { replies };
}

/** One request. `{}` for the three with no response, a payload for the two that have one. */
function apply(model: DocModel, n: number, key: RequestKey, body: unknown): unknown {
  // A non-object body becomes an empty request, so the field-level validation in
  // edit.ts produces the message rather than a TypeError on a null dereference.
  const req = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  switch (key) {
    case "insertText":
      insertText(model, n, req as InsertTextRequest);
      return {};
    case "deleteContentRange":
      deleteContentRange(model, n, req as DeleteContentRangeRequest);
      return {};
    case "updateParagraphStyle":
      updateParagraphStyle(model, n, req as UpdateParagraphStyleRequest);
      return {};
    case "replaceAllText":
      return {
        replaceAllText: {
          occurrencesChanged: replaceAllText(model, n, req as ReplaceAllTextRequest),
        },
      };
    case "createNamedRange":
      return {
        createNamedRange: { namedRangeId: createNamedRange(model, n, req as CreateNamedRangeRequest) },
      };
    case "insertTable":
      // Recognised and honestly refused. A table adds its own indexes for the
      // table, each row and each cell to the flat space, so a half-modelled one
      // would put every later index out of step with the real API — a far worse
      // failure than a 501, and this repo's convention for out-of-scope surface.
      throw new DocsError(501, "insertTable is not implemented in this sandbox.", "UNIMPLEMENTED");
  }
}
