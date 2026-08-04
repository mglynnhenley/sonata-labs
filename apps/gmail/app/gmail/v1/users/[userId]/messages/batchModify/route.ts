import { handleGmail, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { batchModifyMessages } from "@/lib/gmail/mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      ids?: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };
    const ids = body.ids ?? [];
    const add = body.addLabelIds ?? [];
    const remove = body.removeLabelIds ?? [];
    const endpoint = new URL(req.url).pathname;

    runMutation(
      db,
      () => batchModifyMessages(db, ids, add, remove),
      () => ({
        method: "POST",
        endpoint,
        actionType: "batchModify",
        targetType: "message",
        targetId: ids.join(","),
        request: { ids, addLabelIds: add, removeLabelIds: remove },
        responseCode: 204,
        summary: `Batch modified ${ids.length} messages: +[${add.join(", ")}] -[${remove.join(", ")}]`,
      }),
    );
    return noContent();
  });
}
