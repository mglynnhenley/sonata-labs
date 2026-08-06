import { handleGmail, json } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { notFound } from "@/lib/gmail/errors";
import { messageExists } from "@/lib/store/messages";
import { getAttachmentBody } from "@/lib/store/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string; attachmentId: string }> },
) {
  const { userId, id, attachmentId } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.readonly, ({ db }) => {
    if (!messageExists(db, id)) return notFound();
    const body = getAttachmentBody(db, id, attachmentId);
    // null = missing OR over the sync cap (data-less) → Gmail-shaped 404.
    if (!body) return notFound("The attachment was not found.");
    return json(body);
  });
}
