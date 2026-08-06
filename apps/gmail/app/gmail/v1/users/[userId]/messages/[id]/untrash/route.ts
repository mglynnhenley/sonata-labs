import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { untrashMessage } from "@/lib/gmail/mutations";

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
      () => untrashMessage(db, id),
      () => ({
        method: "POST",
        endpoint,
        actionType: "untrash",
        targetType: "message",
        targetId: id,
        responseCode: 200,
        summary: `Untrashed message ${id}`,
      }),
    );
    return json(message);
  });
}
