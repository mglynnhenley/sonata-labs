import { NextResponse } from "next/server";
import { listThreadViews } from "@/lib/gmail-views";
import { bffError } from "@/lib/route-util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    const view = await listThreadViews({
      labelId: sp.get("label") || undefined,
      q: sp.get("q") || undefined,
      page: sp.get("page") ? Number(sp.get("page")) : 0,
      pageSize: 50,
    });
    return NextResponse.json(view);
  } catch (err) {
    return bffError(err);
  }
}
