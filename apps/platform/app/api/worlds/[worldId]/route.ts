import { NextResponse } from "next/server";
import { getWorld } from "../../_lib/records";
import { twinUrls } from "../../_lib/twins";
import { TWIN_NAMES } from "@sonata/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ worldId: string }> }) {
  try {
    const { worldId } = await params;
    const world = getWorld(worldId);
    if (!world) return NextResponse.json({ error: "No such world" }, { status: 404 });
    return NextResponse.json({ world, twins: twinUrls(TWIN_NAMES) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
