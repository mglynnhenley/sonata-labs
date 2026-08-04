import { NextResponse } from "next/server";
import { getOverview } from "@/lib/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The shell polls this. One trip for counts, live runs, scores and twin health. */
export async function GET() {
  try {
    return NextResponse.json(await getOverview());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
