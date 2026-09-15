import { NextResponse } from "next/server";
import { activeRun, listRuns, resumeInterruptedRuns, startRun } from "../_lib/runner";
import type { StartRunInput } from "../_lib/types";
import { CloneBusyError } from "@/lib/engine/cloneLease";
import { normalizeSessionTiming, TWIN_NAMES } from "@sonata/core";
import { getSettings } from "@/lib/settings";
import { resolveScenario } from "@/lib/engine/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    resumeInterruptedRuns();
    const active = activeRun();
    // `at` is the server's clock. Every "4 min ago" in the runs list is measured
    // against it, so the first server paint and the first client render agree.
    return NextResponse.json({
      runs: listRuns(),
      activeRunId: active?.runId ?? null,
      at: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<StartRunInput>;
    if (typeof body.episodeId !== "string" || !body.episodeId.trim()) {
      return NextResponse.json({ error: "Pick a scenario to run." }, { status: 400 });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || !body.model.includes("/"))) {
      return NextResponse.json({ error: "Pick a model using its provider/model slug." }, { status: 400 });
    }
    if (body.ticks !== undefined && (!Number.isInteger(body.ticks) || body.ticks < 1)) throw new Error("ticks must be a positive integer.");
    if (body.compression !== undefined && (!Number.isFinite(body.compression) || body.compression < 1 || body.compression > 3600)) throw new Error("compression must be between 1 and 3600.");
    for (const key of ["judge", "director", "seedWorld"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
    }
    if (body.twins !== undefined && (!Array.isArray(body.twins) || body.twins.some(t => !TWIN_NAMES.includes(t)))) throw new Error("Unsupported apps.");
    for (const key of ["judgeModel", "directorModel", "runId"] as const) {
      if (body[key] !== undefined && typeof body[key] !== "string") throw new Error(`${key} must be a string.`);
    }
    if (body.termination !== undefined) {
      if (!body.termination || typeof body.termination !== "object" || Array.isArray(body.termination)) throw new Error("Invalid termination guards.");
      for (const [key, value] of Object.entries(body.termination)) {
        if (key === "stopWhenAllMustPass" ? typeof value !== "boolean" : !["maxTicks", "idleTicks", "maxWallClockMs", "maxCostUsd"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid termination guard: ${key}.`);
      }
    }

    const doc = startRun({
      episodeId: body.episodeId,
      timing: normalizeSessionTiming(body.timing),
      model: body.model || getSettings().models.agent,
      twins: body.twins ?? [],
      ticks: body.ticks ?? resolveScenario(body.episodeId).spec.clock.ticks,
      platformUrl: process.env.SONATA_PLATFORM_URL || new URL(req.url).origin,
      compression: body.compression, judge: body.judge, director: body.director,
      judgeModel: body.judgeModel, directorModel: body.directorModel,
      seedWorld: body.seedWorld, runId: body.runId, termination: body.termination,
    });
    return NextResponse.json({ runId: doc.runId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof CloneBusyError ? 409 : 400 });
  }
}
