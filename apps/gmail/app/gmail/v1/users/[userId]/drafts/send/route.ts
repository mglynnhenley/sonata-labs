import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { badRequest, notFound } from "@/lib/gmail/errors";
import { getDraftRow } from "@/lib/store/drafts";
import { getMessageRow } from "@/lib/store/messages";
import { prepareSend, commitSendDraft } from "@/lib/drafts-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.send, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    if (!body.id) return badRequest("Missing draft 'id'.");

    const draft = getDraftRow(db, body.id);
    if (!draft) return notFound("Draft not found.");
    const row = getMessageRow(db, draft.message_id);
    if (!row || !row.raw_rfc822) return notFound("Draft content unavailable.");

    // Re-parse the stored RFC822 outside the transaction.
    const prep = await prepareSend(Buffer.from(row.raw_rfc822, "utf8"));
    const endpoint = new URL(req.url).pathname;
    const result = runMutation(
      db,
      () => commitSendDraft(db, body.id!, prep),
      (r) => ({
        method: "POST",
        endpoint,
        actionType: "draftSend",
        targetType: "message",
        targetId: r.messageId,
        request: { draftId: body.id },
        responseCode: 200,
        summary: `Sent draft ${body.id} → “${prep.normalized.subject || "(no subject)"}”`,
      }),
    );
    return json(result.message);
  });
}
