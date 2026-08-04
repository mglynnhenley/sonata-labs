import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { channelView } from "@/lib/ui/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // ?read=1 is sent when the user actively opens the channel; the 3s poll
  // omits it so background refreshes never clear a badge you haven't seen.
  const markRead = new URL(req.url).searchParams.get("read") === "1";
  const view = channelView(getDb(), id, Date.now(), { markRead });
  if (!view) return NextResponse.json({ error: "channel_not_found" }, { status: 404 });
  return NextResponse.json(view);
}
