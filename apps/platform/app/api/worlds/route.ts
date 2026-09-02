import { NextResponse } from "next/server";
import { plannedCounts } from "../_lib/authored";
import { draftScenario, getDraft } from "../_lib/draft";
import { listWorlds, saveWorld } from "../_lib/records";
import { assembleTemplate, getTemplate } from "../_lib/templates";
import { twinUrls } from "../_lib/twins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cloned businesses. A world is the cast, the channels and the company — the
// thing every twin is seeded from, so the same people appear everywhere.

export function GET() {
  try {
    return NextResponse.json({ worlds: listWorlds() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface CreateBody {
  /** Commit the world from a preview the user already saw. */
  draftId?: string;
  /** Clone the business behind a shipped template — the "Start environment" button. */
  templateId?: string;
  /** One-line description, when there was no preview step. */
  brief?: string;
  ticks?: number;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as CreateBody;

    if (body.draftId) {
      const draft = getDraft(body.draftId);
      if (!draft) {
        return NextResponse.json(
          { error: "That preview has expired. Describe the business again to see a fresh one." },
          { status: 404 },
        );
      }
      const world = saveWorld(draft.seed, draft.draft.brief, draft.draft.counts);
      return NextResponse.json({ world, twins: twinUrls(draft.draft.episode.twins) });
    }

    if (body.templateId) {
      const template = getTemplate(body.templateId);
      if (!template) return NextResponse.json({ error: "No such template" }, { status: 404 });
      const { seed, spec, draft } = assembleTemplate(template);
      const world = saveWorld(seed, template.description, plannedCounts(seed, spec.beats));
      return NextResponse.json({ world, twins: twinUrls(draft.episode.twins) });
    }

    const brief = body.brief?.trim();
    if (!brief) {
      return NextResponse.json(
        { error: "Describe the business you want cloned, in a sentence or two." },
        { status: 400 },
      );
    }
    const drafted = await draftScenario(brief, body.ticks ?? 24);
    const world = saveWorld(drafted.seed, brief, drafted.draft.counts);
    return NextResponse.json({ world, twins: twinUrls(drafted.draft.episode.twins) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
