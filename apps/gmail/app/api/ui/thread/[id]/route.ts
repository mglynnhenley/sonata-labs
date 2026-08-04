import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getThreadView } from "@/lib/ui/views";
import { modifyThread } from "@/lib/gmail/mutations";
import { runMutation } from "@/lib/gmail/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const view = getThreadView(db, id);
  if (!view) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Opening a thread marks it read (like Gmail), if requested.
  if (new URL(req.url).searchParams.get("markRead") === "1" && view.messages.some((m) => m.unread)) {
    runMutation(
      db,
      () => modifyThread(db, id, [], ["UNREAD"]),
      () => ({
        method: "GET",
        endpoint: `/api/ui/thread/${id}`,
        actionType: "modify",
        targetType: "thread",
        targetId: id,
        responseCode: 200,
        summary: `Opened thread ${id} (marked read)`,
      }),
    );
    return NextResponse.json(getThreadView(db, id));
  }
  return NextResponse.json(view);
}
