import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { notFound } from "@/lib/gmail/errors";
import { modifyThread } from "@/lib/gmail/mutations";
import { getThread } from "@/lib/store/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.modify, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };
    const add = body.addLabelIds ?? [];
    const remove = body.removeLabelIds ?? [];
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => modifyThread(db, id, add, remove),
      () => ({
        method: "POST",
        endpoint,
        actionType: "modify",
        targetType: "thread",
        targetId: id,
        request: { addLabelIds: add, removeLabelIds: remove },
        responseCode: 200,
        summary: `Modified thread ${id}: +[${add.join(", ")}] -[${remove.join(", ")}]`,
      }),
    );
    const thread = getThread(db, id, "minimal");
    if (!thread) return notFound();
    return json(thread);
  });
}
