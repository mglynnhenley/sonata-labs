import { NextResponse } from "next/server";
import { allTwinStatuses } from "@/lib/twins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health for all three clones. `?force=1` skips the 2s registry cache. */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    return NextResponse.json({ twins: await allTwinStatuses(force) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
