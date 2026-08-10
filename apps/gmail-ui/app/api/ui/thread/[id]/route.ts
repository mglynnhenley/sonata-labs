import { NextResponse } from "next/server";
import { getThreadView, markThreadRead } from "@/lib/gmail-views";
import { bffError } from "@/lib/route-util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    let view = await getThreadView(id);
    if (!view) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Opening a thread marks it read (like Gmail), if requested — a real mutation
    // through the public API, then re-read so the response reflects it.
    if (new URL(req.url).searchParams.get("markRead") === "1" && view.messages.some((m) => m.unread)) {
      await markThreadRead(id);
      view = (await getThreadView(id)) ?? view;
    }
    return NextResponse.json(view);
  } catch (err) {
    return bffError(err);
  }
}
