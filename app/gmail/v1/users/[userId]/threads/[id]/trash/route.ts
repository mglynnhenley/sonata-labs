import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { notFound } from "@/lib/gmail/errors";
import { trashThread } from "@/lib/gmail/mutations";
import { getThread } from "@/lib/store/threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => trashThread(db, id),
      () => ({
        method: "POST",
        endpoint,
        actionType: "trash",
        targetType: "thread",
        targetId: id,
        responseCode: 200,
        summary: `Trashed thread ${id}`,
      }),
    );
    const thread = getThread(db, id, "minimal");
    if (!thread) return notFound();
    return json(thread);
  });
}
