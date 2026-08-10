import { handleGmail, json, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { notFound, badRequest } from "@/lib/gmail/errors";
import { getMessageRow, getLabelIds } from "@/lib/store/messages";
import { deleteMessagePermanent } from "@/lib/gmail/mutations";
import { shapeMessage, canReturnRaw } from "@/lib/gmail/shape";
import type { MessageFormat } from "@/lib/gmail/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS = new Set(["full", "metadata", "minimal", "raw"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.readonly, ({ db }) => {
    const sp = new URL(req.url).searchParams;
    const format = (sp.get("format") || "full").toLowerCase();
    if (!FORMATS.has(format)) {
      return badRequest(`Invalid format '${format}'.`);
    }
    const metadataHeaders = sp.getAll("metadataHeaders");

    const row = getMessageRow(db, id);
    if (!row) return notFound();

    if (format === "raw" && !canReturnRaw(row)) {
      // Gmail only returns raw for messages it stored raw for; synced messages
      // fetched as full don't have it in the sandbox.
      return badRequest("Raw format is not available for this message.");
    }

    const labelIds = getLabelIds(db, id);
    return json(shapeMessage(row, labelIds, format as MessageFormat, metadataHeaders));
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.modify, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => deleteMessagePermanent(db, id),
      () => ({
        method: "DELETE",
        endpoint,
        actionType: "delete",
        targetType: "message",
        targetId: id,
        responseCode: 204,
        summary: `Permanently deleted message ${id}`,
      }),
    );
    return noContent();
  });
}
