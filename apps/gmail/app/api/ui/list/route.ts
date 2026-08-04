import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listThreadViews } from "@/lib/ui/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const db = getDb();
  const sp = new URL(req.url).searchParams;
  const view = listThreadViews(db, {
    labelId: sp.get("label") || undefined,
    q: sp.get("q") || undefined,
    page: sp.get("page") ? Number(sp.get("page")) : 0,
    pageSize: 50,
  });
  return NextResponse.json(view);
}
