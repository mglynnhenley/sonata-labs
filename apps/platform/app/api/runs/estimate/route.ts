import { NextResponse } from "next/server";
import {
  cachesPrompts,
  estimateEpisode,
  formatDuration,
  formatUsd,
  type ModelPrice,
} from "@sonata/benchmark";
import { MODEL_CATALOG } from "@/lib/models";
import { getSettings } from "@/lib/settings";
import { MAX_TICKS, MIN_TICKS } from "../../../runs/_lib/lengths";
import type { RunEstimate, RunEstimateResponse } from "../../../runs/_lib/estimate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WHAT THIS RUN WILL COST, BEFORE IT RUNS.
//
//   GET ?model=anthropic/claude-opus-5&ticks=4,12,24,36
//
// One request prices every length the panel offers, so changing the length is
// instant and only changing the model goes back to the server. The arithmetic is
// @sonata/benchmark's — the same estimator behind `bench --dry-run` — because a
// second one living beside the run button would eventually quote a different
// price for the same day, and the whole point of this number is that it can be
// trusted before any money is spent.
//
// Server-side, not in the panel: the estimator is TypeScript source in a
// workspace package, prices come from Settings-adjacent server state, and the
// director and judge models are not the panel's to know.

/**
 * The catalog's prices, in the estimator's shape. Deliberately NOT
 * `MODEL_PRICES` from @sonata/benchmark: that table is the benchmark's own short
 * list, and the dashboard offers models it has never heard of. A model the
 * catalog does not price comes back in `unpriced` rather than as a guess.
 */
function prices(): Record<string, ModelPrice> {
  return Object.fromEntries(
    MODEL_CATALOG.map((m) => [m.id, { inputPerMTok: m.inputUsd, outputPerMTok: m.outputUsd }]),
  );
}

/** "4,12,24,36" → [4, 12, 24, 36], clamped to what the engine will actually run. */
function parseTicks(raw: string | null): number[] {
  const wanted = (raw ?? "")
    .split(",")
    .map((part) => Math.round(Number(part.trim())))
    .filter((n) => Number.isFinite(n) && n >= MIN_TICKS && n <= MAX_TICKS);
  return [...new Set(wanted)].sort((a, b) => a - b);
}

export function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const model = (url.searchParams.get("model") ?? "").trim();
    if (!model) {
      return NextResponse.json({ error: "Say which model to price." }, { status: 400 });
    }

    const ticks = parseTicks(url.searchParams.get("ticks"));
    if (ticks.length === 0) {
      return NextResponse.json(
        { error: `Say how long the day is, in ticks (${MIN_TICKS}-${MAX_TICKS}).` },
        { status: 400 },
      );
    }

    const settings = getSettings();
    const table = prices();
    const options = {
      prices: table,
      models: { director: settings.models.director, judge: settings.models.judge },
    };

    const estimates: RunEstimate[] = ticks.map((t) => {
      const est = estimateEpisode(t, model, options);
      return {
        ticks: t,
        model,
        usd: est.usd,
        usdLabel: formatUsd(est.usd),
        seconds: est.seconds,
        durationLabel: formatDuration(est.seconds),
        calls: Math.round(est.calls),
        cachePriced: cachesPrompts(model),
        unpriced: est.unpriced,
      };
    });

    const body: RunEstimateResponse = {
      estimates,
      harness: { director: settings.models.director, judge: settings.models.judge },
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
