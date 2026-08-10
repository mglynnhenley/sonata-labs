import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { trashMessage } from "@/lib/gmail/mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.modify, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    const message = runMutation(
      db,
      () => trashMessage(db, id),
      () => ({
        method: "POST",
        endpoint,
        actionType: "trash",
        targetType: "message",
        targetId: id,
        responseCode: 200,
        summary: `Trashed message ${id}`,
      }),
    );
    return json(message);
  });
}
