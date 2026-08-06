import { handleGmail, json, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { notFound, badRequest } from "@/lib/gmail/errors";
import { b64urlDecode } from "@/lib/gmail/base64";
import { getDraftRow, deleteDraftRow } from "@/lib/store/drafts";
import { getMessageRow, getLabelIds, deleteMessage, messageExists } from "@/lib/store/messages";
import { shapeMessage } from "@/lib/gmail/shape";
import { nextHistoryId } from "@/lib/store/meta";
import { prepareSend, commitUpdateDraft } from "@/lib/drafts-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.readonly, ({ db }) => {
    const draft = getDraftRow(db, id);
    if (!draft) return notFound();
    const row = getMessageRow(db, draft.message_id);
    if (!row) return notFound();
    return json({ id: draft.id, message: shapeMessage(row, getLabelIds(db, draft.message_id), "full") });
  });
}

async function update(
  req: Request,
  params: Promise<{ userId: string; id: string }>,
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.compose, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      message?: { raw?: string };
      raw?: string;
    };
    const raw = body.message?.raw ?? body.raw;
    if (!raw) return badRequest("Missing draft 'message.raw'.");
    const prep = await prepareSend(b64urlDecode(raw));
    const endpoint = new URL(req.url).pathname;
    const draft = runMutation(
      db,
      () => commitUpdateDraft(db, id, prep),
      (d) => ({
        method: req.method,
        endpoint,
        actionType: "draftUpdate",
        targetType: "draft",
        targetId: d.id ?? undefined,
        responseCode: 200,
        summary: `Updated draft ${id}`,
      }),
    );
    return json(draft);
  });
}

export const PUT = (req: Request, ctx: { params: Promise<{ userId: string; id: string }> }) =>
  update(req, ctx.params);
export const PATCH = (req: Request, ctx: { params: Promise<{ userId: string; id: string }> }) =>
  update(req, ctx.params);

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.compose, ({ db }) => {
    const draft = getDraftRow(db, id);
    if (!draft) return notFound();
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => {
        if (messageExists(db, draft.message_id)) deleteMessage(db, draft.message_id);
        deleteDraftRow(db, id);
        nextHistoryId(db);
      },
      () => ({
        method: "DELETE",
        endpoint,
        actionType: "draftDelete",
        targetType: "draft",
        targetId: id,
        responseCode: 204,
        summary: `Deleted draft ${id}`,
      }),
    );
    return noContent();
  });
}
