import { handleGmail, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { batchDeleteMessages } from "@/lib/gmail/mutations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
    const ids = body.ids ?? [];
    const endpoint = new URL(req.url).pathname;

    runMutation(
      db,
      () => batchDeleteMessages(db, ids),
      () => ({
        method: "POST",
        endpoint,
        actionType: "batchDelete",
        targetType: "message",
        targetId: ids.join(","),
        request: { ids },
        responseCode: 204,
        summary: `Batch deleted ${ids.length} messages`,
      }),
    );
    return noContent();
  });
}
