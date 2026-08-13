import type { TwinHttp } from "../http";
import { fn, str, type EngineTool, type ToolInput } from "./types";

// The four document tools: read one, start one, add to one, revise one.
//
// There is no list and no search, and that is not an omission. The Docs API has
// no list method — finding a file is Drive's job — so an agent gets to a
// document the way a colleague does: through the link in the email or the Slack
// message that asked for the work. A search tool here would quietly remove the
// step where the agent has to notice which document is meant.
//
// `append_paragraph` and `replace_text` exist instead of a raw batchUpdate
// because the twin's index space is counted in UTF-16 code units and every
// paragraph ends in a newline nobody can see. Handing an agent that arithmetic
// makes the failure mode "it cannot count emoji", which is not what is under
// test; handing it these two makes the failure mode "it wrote the wrong thing",
// which is. Anything finer-grained is still available to it through the
// startIndex/endIndex `read_document` returns.

/** Paragraphs handed back from one read. A brief is tens; a book is a bug. */
const MAX_PARAGRAPHS = 300;

interface WireElement {
  textRun?: { content?: string };
}

interface WireContent {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: WireElement[];
    paragraphStyle?: { namedStyleType?: string };
  };
}

interface DocumentResource {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: WireContent[] };
}

interface BatchUpdateResponse {
  documentId?: string;
  replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }>;
  writeControl?: { requiredRevisionId?: string };
}

/** Where the body ends: the last element's `endIndex`, one past the final newline. */
function bodyEndIndex(doc: DocumentResource): number {
  const content = doc.body?.content ?? [];
  return content[content.length - 1]?.endIndex ?? 1;
}

export function googleDocsTools(http: TwinHttp): EngineTool[] {
  const api = "/v1/documents";

  function path(documentId: string): string {
    return `${api}/${encodeURIComponent(documentId)}`;
  }

  function batchUpdate(documentId: string, requests: unknown[]): Promise<BatchUpdateResponse> {
    return http.post<BatchUpdateResponse>(`${path(documentId)}:batchUpdate`, { requests });
  }

  return [
    {
      name: "read_document",
      twin: "google-docs",
      isMutation: false,
      def: fn(
        "read_document",
        "Read a document by its id — the id is the long string in a docs.google.com link. " +
          "Returns every paragraph with the index range it occupies, which is what the edit " +
          "tools work in. Read before you write.",
        {
          type: "object",
          properties: {
            documentId: { type: "string", description: "From the document's link." },
          },
          required: ["documentId"],
        },
      ),
      async run(input: ToolInput) {
        const doc = await http.get<DocumentResource>(path(str(input.documentId)));
        const content = doc.body?.content ?? [];
        const paragraphs = content
          .filter((c) => c.paragraph)
          .slice(0, MAX_PARAGRAPHS)
          .map((c) => ({
            startIndex: c.startIndex ?? 0,
            endIndex: c.endIndex ?? 0,
            style: c.paragraph?.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
            // Trailing newline dropped: it is an artefact of how a document is
            // stored, it is still counted in endIndex, and leaving it in makes
            // every line of a read end in an escape.
            text: (c.paragraph?.elements ?? [])
              .map((e) => e.textRun?.content ?? "")
              .join("")
              .replace(/\n$/, ""),
          }));
        return {
          documentId: doc.documentId,
          title: doc.title,
          // Send this back on your next write if you want the edit refused when
          // somebody changed the document in between.
          revisionId: doc.revisionId,
          endIndex: bodyEndIndex(doc),
          paragraphs,
          ...(content.filter((c) => c.paragraph).length > MAX_PARAGRAPHS
            ? { truncated: true }
            : {}),
        };
      },
    },
    {
      name: "create_document",
      twin: "google-docs",
      isMutation: true,
      def: fn(
        "create_document",
        "Start a new, empty document. Only the title is set — write the body with " +
          "append_paragraph afterwards.",
        {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      ),
      async run(input: ToolInput) {
        const doc = await http.post<DocumentResource>(api, { title: str(input.title) });
        return { documentId: doc.documentId, title: doc.title, revisionId: doc.revisionId };
      },
    },
    {
      name: "append_paragraph",
      twin: "google-docs",
      isMutation: true,
      def: fn(
        "append_paragraph",
        "Add one paragraph to the end of a document. Give a namedStyleType to make it a " +
          "heading — that is how you start a new section.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            text: { type: "string", description: "The paragraph, without a trailing newline." },
            namedStyleType: {
              type: "string",
              description:
                "NORMAL_TEXT (default), TITLE, SUBTITLE, or HEADING_1 through HEADING_6.",
            },
          },
          required: ["documentId", "text"],
        },
      ),
      async run(input: ToolInput) {
        const documentId = str(input.documentId);
        const text = str(input.text);
        const style = str(input.namedStyleType) || "NORMAL_TEXT";

        // Read first, for the one number this needs: where the body currently
        // ends. That is also where the new paragraph will start, so both
        // requests below can be written before either has landed.
        const doc = await http.get<DocumentResource>(path(documentId));
        const end = bodyEndIndex(doc);
        // A document that has never been written to still has one empty
        // paragraph, because the format requires it. Appending after that one
        // leaves a blank first line in everything anyone reads afterwards, so
        // the first paragraph is written INTO instead — which is what typing
        // into a new document does.
        const blank = end === 2;
        const at = blank ? 1 : end;

        const res = await batchUpdate(documentId, [
          blank
            ? { insertText: { text, location: { index: 1 } } }
            : // The leading "\n" is what makes this a new paragraph rather than
              // a longer last one: the insertion lands immediately before the
              // body's final newline, so text sent without it joins the
              // paragraph already sitting in front of it.
              { insertText: { text: `\n${text}`, endOfSegmentLocation: {} } },
          // Always sent, never only for headings. A new paragraph inherits the
          // style of the one it grew out of, so a plain line appended under a
          // heading is silently a second heading — the outline the judge reads
          // would then disagree with the document the agent thought it wrote.
          {
            updateParagraphStyle: {
              range: { startIndex: at, endIndex: at },
              paragraphStyle: { namedStyleType: style },
              fields: "namedStyleType",
            },
          },
        ]);
        return {
          documentId,
          revisionId: res.writeControl?.requiredRevisionId,
          appended: text,
          style,
        };
      },
    },
    {
      name: "replace_text",
      twin: "google-docs",
      isMutation: true,
      def: fn(
        "replace_text",
        "Replace every occurrence of a phrase in a document — how you fill in a placeholder " +
          "or correct a sentence. The phrase must match exactly; read the document first.",
        {
          type: "object",
          properties: {
            documentId: { type: "string" },
            find: { type: "string", description: "The exact text to look for." },
            replaceWith: { type: "string", description: "Empty string deletes the phrase." },
            matchCase: { type: "boolean", description: "Default false." },
          },
          required: ["documentId", "find", "replaceWith"],
        },
      ),
      async run(input: ToolInput) {
        const documentId = str(input.documentId);
        const find = str(input.find);
        const res = await batchUpdate(documentId, [
          {
            replaceAllText: {
              containsText: { text: find, matchCase: input.matchCase === true },
              replaceText: str(input.replaceWith),
            },
          },
        ]);
        const occurrencesChanged = res.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        // A replacement that matched nothing answers 200 and changes nothing.
        // Reported as an error rather than as a quiet zero because the trace is
        // where "it said it filled in the placeholder" gets caught, and the
        // agent needs to know now, while it can still go and look.
        return occurrencesChanged
          ? { documentId, occurrencesChanged, revisionId: res.writeControl?.requiredRevisionId }
          : {
              documentId,
              occurrencesChanged,
              error: `"${find}" appears nowhere in this document — nothing was changed`,
            };
      },
    },
  ];
}
