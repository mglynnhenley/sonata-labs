import { handleDocs, json, runMutation } from "@/lib/docs/route-helpers";
import { shapeDocument } from "@/lib/docs/shape";
import { insertDocument, loadDocument } from "@/lib/store/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /v1/documents — documents.create. The agent's starting move when there is
// nothing to edit yet.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { title?: unknown };
  return handleDocs(req, ({ db, ownerEmail }) => {
    // Title is the ONLY field honoured, exactly as the vendor documents: "Other
    // fields in the request, including any provided content, are ignored." Do not
    // later start honouring a supplied body — an agent that gets content back
    // from create would stop sending the batchUpdate that really writes it.
    const title = typeof body.title === "string" && body.title.trim() ? body.title : "Untitled document";
    const now = Date.now();
    const row = runMutation(
      db,
      () =>
        insertDocument(db, {
          title,
          ownerEmail,
          createdMs: now,
          updatedMs: now,
          isSandboxCreated: true,
        }),
      (created) => ({
        method: "POST",
        endpoint: "/v1/documents",
        actionType: "documentCreate",
        targetType: "document",
        targetId: created.id,
        request: body,
        responseCode: 200,
        summary: `Created “${created.title}”`,
      }),
    );
    // Read back rather than shaping the input: the blank-document body is written
    // by the store, and this is the same path documents.get takes.
    return json(shapeDocument(loadDocument(db, row.id)!, {}));
  });
}
