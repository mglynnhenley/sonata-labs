import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { modifyMessage } from "@/lib/gmail/mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };
    const add = body.addLabelIds ?? [];
    const remove = body.removeLabelIds ?? [];
    const endpoint = new URL(req.url).pathname;

    const message = runMutation(
      db,
      () => modifyMessage(db, id, add, remove),
      () => ({
        method: "POST",
        endpoint,
        actionType: "modify",
        targetType: "message",
        targetId: id,
        request: { addLabelIds: add, removeLabelIds: remove },
        responseCode: 200,
        summary: `Modified ${id}: +[${add.join(", ")}] -[${remove.join(", ")}]`,
      }),
    );
    return json(message);
  });
}
