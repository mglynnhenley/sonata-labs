import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { threadView } from "@/lib/ui/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; ts: string }> }) {
  const { id, ts } = await ctx.params;
  const view = threadView(getDb(), id, ts);
  if (!view) return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  return NextResponse.json(view);
}
