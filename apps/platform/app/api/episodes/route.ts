import { NextResponse } from "next/server";
import { plannedCounts } from "../_lib/authored";
import { draftScenario, getDraft } from "../_lib/draft";
import { listEpisodes, saveEpisode, saveWorld } from "../_lib/records";
import { assembleTemplate, getTemplate, templateSummaries } from "../_lib/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scenarios. One GET serves the whole Scenarios page — saved scenarios and the
// shipped templates — because the page renders them together and two requests
// would let the two halves arrive at different times.

export function GET() {
  try {
    return NextResponse.json({ episodes: listEpisodes(), templates: templateSummaries() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

interface CreateBody {
  /** Commit the scenario the user previewed. */
  draftId?: string;
  /** Save a copy of a shipped template. */
  templateId?: string;
  /** Describe-and-create in one step, skipping the preview. */
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
          { error: "That preview has expired. Describe the day again to see a fresh one." },
          { status: 404 },
        );
      }
      const world = saveWorld(draft.seed, draft.draft.brief, draft.draft.counts);
      const episode = saveEpisode(draft.spec, world, null);
      return NextResponse.json({ episode });
    }

    if (body.templateId) {
      const template = getTemplate(body.templateId);
      if (!template) return NextResponse.json({ error: "No such template" }, { status: 404 });
      const { seed, spec } = assembleTemplate(template);
      const world = saveWorld(seed, template.description, plannedCounts(seed, spec.beats));
      const episode = saveEpisode(spec, world, template.id);
      return NextResponse.json({ episode });
    }

    const brief = body.brief?.trim();
    if (!brief) {
      return NextResponse.json(
        { error: "Describe the business and what happens today." },
        { status: 400 },
      );
    }
    const drafted = await draftScenario(brief, body.ticks ?? 24);
    const world = saveWorld(drafted.seed, brief, drafted.draft.counts);
    const episode = saveEpisode(drafted.spec, world, null);
    return NextResponse.json({ episode });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
