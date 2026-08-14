import { applyBatchUpdate, checkWriteControl, type WriteControl } from "@/lib/docs/batch";
import { badRequest, notFound } from "@/lib/docs/errors";
import { newRevisionId } from "@/lib/docs/ids";
import {
  handleDocs,
  json,
  requireDocument,
  runMutation,
  splitCustomMethod,
} from "@/lib/docs/route-helpers";
import { shapeDocument } from "@/lib/docs/shape";
import { saveDocument } from "@/lib/store/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `params` is a Promise in this Next version, and the segment arrives whole —
// `1AbC…:batchUpdate` — because the write endpoint is a `resource:verb` custom
// method rather than a nested path.
type Ctx = { params: Promise<{ documentId: string }> };

const SUGGESTIONS_VIEW_MODES = [
  "DEFAULT_FOR_CURRENT_ACCESS",
  "SUGGESTIONS_INLINE",
  "PREVIEW_SUGGESTIONS_ACCEPTED",
  "PREVIEW_WITHOUT_SUGGESTIONS",
];

/** GET /v1/documents/{documentId} — documents.get. */
export async function GET(req: Request, ctx: Ctx) {
  const [documentId, method] = splitCustomMethod((await ctx.params).documentId);
  // The vendor has no GET on a custom method path, and answering one here would
  // teach an agent a URL that does not exist upstream.
  if (method !== null) return notFound();

  const sp = new URL(req.url).searchParams;
  const requested = sp.get("suggestionsViewMode");
  if (requested !== null && !SUGGESTIONS_VIEW_MODES.includes(requested)) {
    return badRequest(`Invalid value for parameter 'suggestionsViewMode': ${requested}`);
  }
  // The sandbox holds no suggestions, so every mode renders the same content. The
  // parameter is honoured and echoed so an agent that sends one is not surprised
  // by a 400; DEFAULT_FOR_CURRENT_ACCESS resolves the way an editor's would.
  const suggestionsViewMode =
    !requested || requested === "DEFAULT_FOR_CURRENT_ACCESS" ? "SUGGESTIONS_INLINE" : requested;

  return handleDocs(req, ({ db }) =>
    json(
      shapeDocument(requireDocument(db, documentId), {
        suggestionsViewMode,
        includeTabsContent: sp.get("includeTabsContent") === "true",
      }),
    ),
  );
}

/** POST /v1/documents/{documentId}:batchUpdate — the whole write surface. */
export async function POST(req: Request, ctx: Ctx) {
  const [documentId, method] = splitCustomMethod((await ctx.params).documentId);
  if (method !== "batchUpdate") return notFound();

  const body = (await req.json().catch(() => ({}))) as {
    requests?: unknown;
    writeControl?: WriteControl;
  };

  return handleDocs(req, ({ db }) => {
    const model = requireDocument(db, documentId);
    checkWriteControl(model, body.writeControl);
    const requests = body.requests ?? [];
    const kinds = Array.isArray(requests)
      ? requests.map((r) => Object.keys((r ?? {}) as object)[0] ?? "?")
      : [];

    // Any error thrown out of applyBatchUpdate aborts the transaction, so the
    // document and its audit row roll back together — which matches the vendor
    // (one invalid request fails the whole batch) and means a failed batch leaves
    // no trace in the log at all. That absence is the design, not the agent
    // having declined to try.
    const result = runMutation(
      db,
      () => {
        const { replies } = applyBatchUpdate(model, requests);
        // The vendor mints a revision for any batch it applies; `requests: []` is
        // a legal no-op that leaves the document, and its revision, exactly where
        // they were.
        if (replies.length) {
          model.revisionId = newRevisionId();
          saveDocument(db, model, Date.now());
        }
        return { replies, revisionId: model.revisionId };
      },
      () => ({
        method: "POST",
        endpoint: `/v1/documents/${documentId}:batchUpdate`,
        actionType: "documentBatchUpdate",
        targetType: "document",
        targetId: documentId,
        request: requests,
        responseCode: 200,
        summary: `Applied ${kinds.length} request(s) to “${model.title}” (${kinds.join(", ")})`,
      }),
    );

    return json({
      documentId,
      replies: result.replies,
      writeControl: { requiredRevisionId: result.revisionId },
    });
  });
}
