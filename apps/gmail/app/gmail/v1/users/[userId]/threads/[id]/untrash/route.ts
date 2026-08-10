import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { notFound } from "@/lib/gmail/errors";
import { untrashThread } from "@/lib/gmail/mutations";
import { getThread } from "@/lib/store/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.modify, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => untrashThread(db, id),
      () => ({
        method: "POST",
        endpoint,
        actionType: "untrash",
        targetType: "thread",
        targetId: id,
        responseCode: 200,
        summary: `Untrashed thread ${id}`,
      }),
    );
    const thread = getThread(db, id, "minimal");
    if (!thread) return notFound();
    return json(thread);
  });
}
