import { NextResponse } from "next/server";
import { draftScenario } from "../../_lib/draft";
import { sweepDrafts } from "../../_lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Preview step of the new-scenario flow: one description in, the whole day
// out — cast, channels, the beats that will fire and the criteria it will be
// scored against — before a single row is written anywhere. The result is parked
// as a draft so pressing Create commits exactly what was shown.

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { brief?: string; ticks?: number };
    const brief = body.brief?.trim();
    if (!brief || brief.length < 12) {
      return NextResponse.json(
        {
          error:
            "Tell us a bit more — the business, and what happens today. One or two sentences is enough.",
        },
        { status: 400 },
      );
    }

    sweepDrafts();
    const { draft } = await draftScenario(brief, body.ticks ?? 24);
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
