import { NextResponse } from "next/server";
import { deleteEpisode, getEpisode } from "../../_lib/records";
import { twinUrls } from "../../_lib/twins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ episodeId: string }> }) {
  try {
    const { episodeId } = await params;
    const episode = getEpisode(episodeId);
    if (!episode) return NextResponse.json({ error: "No such scenario" }, { status: 404 });
    return NextResponse.json({ episode, twins: twinUrls(episode.twins) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ episodeId: string }> }) {
  try {
    const { episodeId } = await params;
    // Runs are deliberately kept: a result must outlive the scenario it came
    // from, or the benchmark table develops holes.
    return NextResponse.json({ deleted: deleteEpisode(episodeId) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
