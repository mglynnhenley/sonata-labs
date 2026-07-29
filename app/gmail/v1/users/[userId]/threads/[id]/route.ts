import { handleGmail, json, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { notFound, badRequest } from "@/lib/gmail/errors";
import { getThread } from "@/lib/store/threads";
import { deleteThreadPermanent } from "@/lib/gmail/mutations";
import type { MessageFormat } from "@/lib/gmail/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS = new Set(["full", "metadata", "minimal"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const format = (new URL(req.url).searchParams.get("format") || "full").toLowerCase();
    if (!FORMATS.has(format)) return badRequest(`Invalid format '${format}'.`);
    const thread = getThread(db, id, format as MessageFormat);
    if (!thread) return notFound();
    return json(thread);
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => deleteThreadPermanent(db, id),
      () => ({
        method: "DELETE",
        endpoint,
        actionType: "delete",
        targetType: "thread",
        targetId: id,
        responseCode: 204,
        summary: `Permanently deleted thread ${id}`,
      }),
    );
    return noContent();
  });
}
