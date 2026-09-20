import { NextResponse } from "next/server";
import { plannedTicks, type Criterion, type EpisodeSpec } from "@sonata/core";
import { bindCriteria, checklistShortfall } from "@sonata/world";
import { factNameFor } from "@sonata/judge";
import { bindableBeats, guardsFor, vetCriterionKinds } from "../../_lib/authored";
import { deleteEpisode, getEpisode, saveEpisode } from "../../_lib/records";
import { liveWorkFor } from "../../_lib/runner";
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

/**
 * Edit a saved scenario's GRADING half: what the agent is told, how long the day
 * is, what counts as done, and what the judge is asked in prose.
 *
 * Deliberately narrow. Beats, cast and channels are derived artifacts — ids,
 * addresses and ISO instants are all assembled in code — so editing them means
 * re-running assembly, not patching a field. Everything accepted here is 1:1
 * with the stored spec and needs no re-derivation.
 *
 * Criteria go through the SAME two gates the generator uses rather than a second
 * copy of the rules: `vetCriterionKinds` closes the vocabulary (the `mentioned`
 * vs `mentions` incident is what that gate exists for) and `bindCriteria` refuses
 * anything a checker could never settle. A criterion that cannot be evaluated
 * must be impossible to author, not discovered on a report later.
 *
 * AFFECTS FUTURE RUNS ONLY. A run embeds the spec it played, so past verdicts
 * keep the rubric they were actually judged against. The one day that is
 * neither past nor future is the one being played right now, and that day is
 * refused: a session reads the spec back when it is scored, and even a run that
 * embedded its copy is graded against a rubric the operator has just changed
 * their mind about. Wait for it, or abort it — see docs/benchmark-realism-plan.md.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ episodeId: string }> },
) {
  try {
    const { episodeId } = await params;
    const record = getEpisode(episodeId);
    if (!record) return NextResponse.json({ error: "No such scenario" }, { status: 404 });

    // Checked twice: here, so a busy scenario answers fast, and again right
    // before the write, because reading and vetting the body below awaits and a
    // run can start in that gap.
    const live = liveWorkFor(episodeId);
    if (live) return busy(live);

    const patch = (await request.json()) as {
      task?: string;
      story?: string;
      title?: string;
      ticks?: number;
      checklist?: Criterion[];
      judgeQuestions?: string[];
    };

    const spec: EpisodeSpec = structuredClone(record.spec);

    if (patch.title !== undefined) {
      if (!patch.title.trim()) return bad("a scenario needs a title");
      spec.title = patch.title.trim();
    }
    if (patch.story !== undefined) spec.story = patch.story.trim();
    if (patch.task !== undefined) {
      if (patch.task.trim().length < 40) {
        return bad("the agent's brief is its whole job description — write at least a sentence");
      }
      spec.task = patch.task.trim();
    }

    if (patch.ticks !== undefined) {
      const ticks = Math.round(patch.ticks);
      if (!Number.isFinite(ticks) || ticks < 1 || ticks > 200) {
        return bad("a day must be between 1 and 200 ticks");
      }
      spec.clock = { ...spec.clock, ticks };
      // Guards are sized from the clock. Leaving them behind is the documented
      // failure where a 32-tick day was filed "done" at tick 12 and the agent
      // was graded against beats it was never shown.
      spec.termination = { ...spec.termination, ...guardsFor(spec.clock) };
    }

    if (patch.judgeQuestions !== undefined) {
      const qs = patch.judgeQuestions.map((q) => q.trim()).filter(Boolean);
      if (qs.length > 8) return bad("more than eight questions and the judge stops answering any of them well");
      spec.success = { ...spec.success, judgeQuestions: qs };
    }

    if (patch.checklist !== undefined) {
      const vetted = vetCriterionKinds(patch.checklist as never);
      if (vetted.rejected.length) {
        return NextResponse.json(
          { error: vetted.rejected[0].why, rejected: vetted.rejected },
          { status: 400 },
        );
      }
      const report = bindCriteria(vetted.ok as never, {
        beats: bindableBeats(spec.beats),
        channels: spec.world.channels.map((c) => c.name),
        person: (ref: string) => {
          const want = ref.trim().toLowerCase();
          return spec.world.cast.find(
            (x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want,
          )?.id;
        },
        hasChecker: (twin, kind) => factNameFor(twin, kind) !== null,
      });
      if (report.unbound.length) {
        return NextResponse.json(
          { error: report.unbound[0].why, unbound: report.unbound },
          { status: 400 },
        );
      }
      // Merge the normalized fields back onto the criteria that came in, rather
      // than storing `report.bound` wholesale. `normalize` returns the world
      // package's DraftCriterion — the generator's pre-id shape — so taking its
      // output verbatim silently drops `Criterion.id`, and an id is what a run
      // report keys its evidence by. `bound` is 1:1 and in order with the input
      // whenever `unbound` is empty, which is the only branch that reaches here.
      spec.success = {
        ...spec.success,
        checklist: report.bound.map((bound, i) => ({
          ...vetted.ok[i],
          ...bound,
          id: (vetted.ok[i] as unknown as Criterion).id,
          weight: bound.weight ?? (vetted.ok[i] as unknown as Criterion).weight ?? 1,
        })) as unknown as Criterion[],
      };
    }

    // The product's own floor for "would this actually score the day".
    const shortfall = checklistShortfall(spec.success.checklist as never);
    if (shortfall) return bad(shortfall);

    const liveNow = liveWorkFor(episodeId);
    if (liveNow) return busy(liveNow);
    const saved = saveEpisode(
      spec,
      { id: record.worldId, name: record.worldName },
      record.templateId,
      record.createdAt,
    );
    return NextResponse.json({ episode: saved, ticks: plannedTicks(spec) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function busy(live: NonNullable<ReturnType<typeof liveWorkFor>>) {
  return NextResponse.json(
    {
      error:
        `${live.kind === "run" ? "Run" : "Session"} ${live.id} is still playing this scenario, ` +
        "and editing it now would change the rubric mid-run. Wait for it to finish, or abort it, " +
        "then try again.",
      live,
    },
    { status: 409 },
  );
}
