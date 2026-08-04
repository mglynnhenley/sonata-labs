import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { searchMessages } from "@/lib/search/compile";
import { getSelf } from "@/lib/store/meta";
import { getConversation } from "@/lib/store/conversations";
import { uiAuthor } from "@/lib/ui/views";
import { tsToMs } from "@/lib/slack/ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const db = getDb();
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!q.trim()) return NextResponse.json({ query: q, total: 0, matches: [] });
  const self = getSelf(db);
  const { total, matches } = searchMessages(db, q, self.userId, { count: 50, page: 1 });
  return NextResponse.json({
    query: q,
    total,
    matches: matches.map((m) => {
      const conv = getConversation(db, m.channel_id);
      return {
        channelId: m.channel_id,
        channelName: conv?.name ?? conv?.id ?? m.channel_id,
        channelKind: conv?.is_im ? "im" : conv?.is_mpim ? "mpim" : conv?.is_private ? "private" : "channel",
        ts: m.ts,
        timeMs: tsToMs(m.ts),
        author: uiAuthor(db, m),
        text: m.text ?? "",
        threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
      };
    }),
  });
}
