import { NextResponse } from "next/server";
import { buildEpisodePrompt } from "@sonata/judge";
import { buildJudgeInput } from "../../_lib/rejudge";
import { readRun, readSpec } from "../../../../results/_lib/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The exact prompt this run's judge is given, without spending anything.
//
// `buildJudgeInput` and `buildEpisodePrompt` are both pure and both already
// exported, so the string the model would receive can be built and shown for
// free. That is the whole point: judging is the one part of this product a user
// cannot otherwise inspect — the checklist shows its evidence, but the judge's
// half is a model call into the dark. A reader who can see the prompt can see
// that their brief and their questions are what actually arrive, and where the
// day's coverage was cut.
//
// Read-only, and cheap enough to open every time.

/** In prompt order. Every heading `buildEpisodePrompt` can emit. */
const HEADINGS = [
  "THE TASK THE AGENT WAS GIVEN",
  "FIRST, RESTATE THE TASK",
  "HOW MUCH OF THIS RUN YOU ARE READING",
  "THE DAY, AS IT HAPPENED",
  "WHAT THE AGENT DID",
  "WHAT THE AGENT SAID",
  "WHAT THE WORLD DID BACK",
  "WHAT CHANGED ON EACH SURFACE",
  "WHERE THINGS ENDED UP",
  "DETERMINISTIC CHECKS ALREADY RUN",
  "FAILURE MODES TO CHECK",
  "QUESTIONS THIS EPISODE ASKS BY NAME",
  "THE QUESTION",
] as const;

/** ~4 chars a token is close enough to budget on, and it is what costs money. */
const CHARS_PER_TOKEN = 4;

function sections(prompt: string): Array<{ heading: string; chars: number; body: string }> {
  const found = HEADINGS.map((h) => ({ heading: h, at: prompt.indexOf(h) })).filter((x) => x.at >= 0);
  found.sort((a, b) => a.at - b.at);
  return found.map((x, i) => {
    const end = i + 1 < found.length ? found[i + 1].at : prompt.length;
    const body = prompt.slice(x.at, end);
    return { heading: x.heading, chars: body.length, body };
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const run = readRun(runId);
    if (!run) return NextResponse.json({ error: "No such run" }, { status: 404 });

    const { system, prompt, coverage } = buildEpisodePrompt(buildJudgeInput(run, readSpec(runId)));
    return NextResponse.json({
      system,
      prompt,
      coverage,
      sections: sections(prompt),
      approxTokens: Math.round((system.length + prompt.length) / CHARS_PER_TOKEN),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
