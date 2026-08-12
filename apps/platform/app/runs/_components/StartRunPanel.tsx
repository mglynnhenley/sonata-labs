"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  buttonClasses,
  Card,
  Chip,
  EmptyState,
  IconArrowRight,
  IconLayers,
  IconPlay,
  SERVICE_LABELS,
  cn,
} from "@sonata/ui";
import { TWIN_NAMES, type TwinName } from "@sonata/core";
import { MODEL_CATALOG, findModel, usd } from "@/lib/models";
import type { EpisodeSummary, StartRunInput } from "../../api/_lib/types";
import type { RunEstimate, RunEstimateResponse } from "../_lib/estimate";
import {
  MAX_TICKS,
  MIN_TICKS,
  SMOKE_TICKS,
  beatsCutOff,
  isShortened,
  lengthsFor,
} from "../_lib/lengths";

// Everything it takes to start a day, on one card, with no page in between.
// Four choices and a button; the twins and the day length are pre-filled from
// the scenario, so the fast path is pick-a-scenario and press.
//
// The prices are the reason this card is not just a form. A day is minutes of
// billable model calls, and until the estimate went on the buttons the only way
// to find out what a length or a model cost was to buy it. Every figure here
// comes from /api/runs/estimate, which is @sonata/benchmark's estimator — the
// same arithmetic as `bench --dry-run`, fitted against Sonata's own saved runs.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-[13px] text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

export type StartRunPanelProps = {
  episodes: readonly EpisodeSummary[];
  /** The agent model from Settings — the choice already made once. */
  defaultModel: string;
  /**
   * Which ticks each scenario has scripted moments on, by scenario id. Read
   * server-side off the saved spec, and the only way this panel can say WHICH
   * beats a short day will miss instead of vaguely warning that some might.
   */
  beatTicks: Record<string, number[]>;
  /** Preselected from `?scenario=`, so "Start a run" on a card lands ready. */
  initialEpisodeId?: string;
  starting: boolean;
  onStart: (input: StartRunInput) => void;
};

export function StartRunPanel({
  episodes,
  defaultModel,
  beatTicks,
  initialEpisodeId,
  starting,
  onStart,
}: StartRunPanelProps) {
  const first = initialEpisodeId ?? episodes[0]?.id ?? "";
  const [episodeId, setEpisodeId] = useState(first);
  const [model, setModel] = useState(defaultModel);
  const [ticks, setTicks] = useState<number>(SMOKE_TICKS);
  const [twins, setTwins] = useState<TwinName[]>([]);
  const [priced, setPriced] = useState<RunEstimateResponse | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [spendAnyway, setSpendAnyway] = useState(false);

  const episode = useMemo(() => episodes.find((e) => e.id === episodeId), [episodes, episodeId]);
  const scenarioTicks = episode?.counts.ticks ?? 0;
  const lengths = useMemo(() => lengthsFor(scenarioTicks), [scenarioTicks]);

  // The scenario decides which surfaces matter and how long the day is; picking
  // a different one has to move both, or the run panel quietly lies.
  useEffect(() => {
    if (!episode) return;
    setTwins(episode.twins);
    setTicks(episode.counts.ticks);
  }, [episode]);

  // One request prices every length on offer, so only a model change costs a
  // round trip. Aborted on change: the panel must never show a price that
  // belongs to a model the user has already moved off.
  const lengthKey = lengths.map((l) => l.ticks).join(",");
  useEffect(() => {
    if (!model || lengthKey === "") return;
    const wanted = lengthKey.includes(String(SMOKE_TICKS))
      ? lengthKey
      : `${SMOKE_TICKS},${lengthKey}`;
    const stop = new AbortController();
    setPricingError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/runs/estimate?model=${encodeURIComponent(model)}&ticks=${wanted}`,
          { signal: stop.signal },
        );
        const body = (await res.json()) as RunEstimateResponse & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `Estimate failed (${res.status})`);
        setPriced(body);
      } catch (err) {
        if (stop.signal.aborted) return;
        // Blanking the old estimate is deliberate. A stale price beside a Start
        // button is worse than no price: it reads as measured when it is not.
        setPriced(null);
        setPricingError((err as Error).message);
      }
    })();
    return () => stop.abort();
  }, [model, lengthKey]);

  const estimateFor = (n: number): RunEstimate | undefined =>
    priced?.estimates.find((e) => e.ticks === n);
  const chosen = estimateFor(ticks);
  const smoke = estimateFor(SMOKE_TICKS);

  if (episodes.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size="lg" />}
        title="A run needs a scenario"
        description="A scenario is one simulated workday: who is in the company, what happens and when, and what counts as having done the job. Save one and this panel fills in."
        hints={[
          "Five ready-made days ship with the product — start from one of those",
          "Or describe your own business in a sentence and let Sonata write it",
        ]}
        action={
          <a href="/scenarios" className={buttonClasses("primary", "md")}>
            See the five scenarios
            <IconArrowRight size="sm" />
          </a>
        }
      />
    );
  }

  const chosenModel = findModel(model);
  const unpriced = chosen?.unpriced ?? [];
  const shortened = isShortened(ticks, scenarioTicks);
  const missedBeats = beatsCutOff(beatTicks[episodeId] ?? [], ticks);

  // The two ways a run could start on a price nobody has seen: the estimate
  // never arrived, or it arrived with a model in it that has no price on file.
  // The first blocks; the second asks, because an unlisted OpenRouter slug is a
  // legitimate thing to test and refusing it outright would be the wrong fix.
  const blocked = !chosen && pricingError === null;
  const needsConsent = unpriced.length > 0 && !spendAnyway;
  const canStart = Boolean(episodeId) && twins.length > 0 && !blocked && !needsConsent;

  return (
    <Card padding="lg">
      {/* Only the two selects are peers, so only they pair off. Beside the lengths
          — three priced buttons, a tick box and a truncation notice — the chip row
          ran out about 150px short and left the start button below a hole. The two
          button groups take the whole card instead, which is also what lets the
          lengths sit three across rather than wrapping two-then-one. */}
      <div className="sn-stack-block">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <label htmlFor="run-scenario" className="text-[13px] font-medium text-sn-ink">
              Scenario
            </label>
            <select
              id="run-scenario"
              className={cn(CONTROL, "mt-2")}
              value={episodeId}
              onChange={(e) => setEpisodeId(e.target.value)}
            >
              {episodes.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                  {option.worldName ? ` — ${option.worldName}` : ""}
                </option>
              ))}
            </select>
            <p className="mt-2 line-clamp-2 text-[12px] leading-[18px] text-sn-muted">
              {episode?.story ?? "Pick the day you want to test against."}
            </p>
          </div>

          <div>
            <label htmlFor="run-model" className="text-[13px] font-medium text-sn-ink">
              Model under test
            </label>
            <select
              id="run-model"
              className={cn(CONTROL, "mt-2")}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {chosenModel ? null : <option value={model}>{model}</option>}
              {byVendor().map(([vendor, models]) => (
                <optgroup key={vendor} label={vendor}>
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-2 text-[12px] leading-[18px] text-sn-muted">
              {chosenModel
                ? `${chosenModel.note} · ${usd(chosenModel.inputUsd)} in / ${usd(chosenModel.outputUsd)} out per million tokens`
                : "An OpenRouter model id."}
            </p>
          </div>
        </div>

        <div>
          <p className="text-[13px] font-medium text-sn-ink">Where the agent can work</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {TWIN_NAMES.map((twin) => {
              const on = twins.includes(twin);
              const used = episode?.twins.includes(twin) ?? false;
              return (
                <Chip
                  key={twin}
                  service={twin}
                  selected={on}
                  onClick={() =>
                    setTwins((current) =>
                      current.includes(twin)
                        ? current.filter((t) => t !== twin)
                        : TWIN_NAMES.filter((t) => t === twin || current.includes(t)),
                    )
                  }
                >
                  {SERVICE_LABELS[twin]}
                  {used ? "" : " (unused)"}
                </Chip>
              );
            })}
          </div>
          {/* Capped because the block is the width of the card now, and a sentence
              this long across all of it is a line nobody's eye can carry back. */}
          <p className="mt-2 max-w-[76ch] text-[12px] leading-[18px] text-sn-muted">
            Detach an app to see what the agent does without it — that is the cheapest way to
            find out which surface it was actually relying on.
          </p>
        </div>

        <div>
          {/* The caption sits beside the label, not at the far end of the row: across
              the full card those two ended up a screen apart and stopped reading as
              one thought. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-[13px] font-medium text-sn-ink">How long the day runs</p>
            <p className="text-[11.5px] text-sn-subtle">
              This run only — the scenario keeps its clock.
            </p>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {lengths.map((length) => {
              const price = estimateFor(length.ticks);
              const on = ticks === length.ticks;
              return (
                <button
                  key={length.ticks}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTicks(length.ticks)}
                  className={cn(
                    // Equal shares of the row, whether there are two lengths on offer
                    // or four. Sized to their own text they came out 194/140/222 wide
                    // and read as three different kinds of thing. The floor stays:
                    // a long scenario offers four, and basis-0 alone would let the
                    // narrowest breakpoint squeeze them past legibility.
                    "grow basis-full rounded-sn-md border px-3 py-2 text-left transition-colors duration-150 ease-sn sm:basis-0 sm:min-w-[8.5rem]",
                    on
                      ? "border-sn-primary bg-sn-primary-soft text-sn-primary-ink"
                      : "border-sn-line bg-sn-surface text-sn-muted hover:border-sn-line-strong",
                  )}
                >
                  <span className="block text-[13px] font-medium">{length.label}</span>
                  <span className="block text-[11.5px] text-sn-subtle">{length.hint}</span>
                  <span
                    data-numeric
                    className={cn(
                      "mt-1 block text-[11.5px] tabular-nums",
                      on ? "text-sn-primary-ink" : "text-sn-muted",
                    )}
                  >
                    {price ? `≈ ${price.usdLabel} · ${price.durationLabel}` : "pricing…"}
                  </span>
                </button>
              );
            })}
          </div>

          <label
            htmlFor="run-ticks"
            className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-sn-muted"
          >
            <span>or run exactly</span>
            <input
              id="run-ticks"
              type="number"
              min={MIN_TICKS}
              max={MAX_TICKS}
              value={ticks}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) setTicks(Math.max(MIN_TICKS, Math.min(MAX_TICKS, n)));
              }}
              className="h-8 w-20 rounded-sn-md border border-sn-line bg-sn-surface px-2 text-[13px] tabular-nums text-sn-ink"
            />
            <span>ticks of 15 simulated minutes</span>
          </label>

          {shortened ? (
            // The honest cost of a short day. The harness already understands
            // this: `runTruncation` marks anything that never fired as OUR
            // defect, not the agent's, so a smoke test cannot quietly invent a
            // failure. Saying so here is what makes the short day usable.
            <p className="mt-3 rounded-sn-md border border-sn-line bg-sn-bg-subtle px-3 py-2 text-[12px] leading-[18px] text-sn-muted">
              The day stops at tick {ticks} of {scenarioTicks}.
              {missedBeats > 0
                ? ` ${missedBeats} scripted moment${missedBeats === 1 ? "" : "s"} scheduled after that never reach the agent, and the report marks ${missedBeats === 1 ? "it" : "them"} as a harness defect rather than an agent failure.`
                : " Nothing the scenario scripted falls outside it, but anything the brief expected later had no chance to happen."}{" "}
              A short day smoke-tests a change; it does not score one.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-7 border-t border-sn-line pt-5">
        {pricingError ? (
          <p className="mb-4 rounded-sn-md border border-sn-failed-line bg-sn-danger-soft px-3 py-2 text-[12px] leading-[18px] text-sn-danger-ink">
            Could not work out what this run will cost: {pricingError}
          </p>
        ) : null}

        {unpriced.length > 0 ? (
          <label className="mb-4 flex items-start gap-2.5 rounded-sn-md border border-sn-line-strong bg-sn-warning-soft px-3 py-2 text-[12px] leading-[18px] text-sn-warning-ink">
            <input
              type="checkbox"
              checked={spendAnyway}
              onChange={(e) => setSpendAnyway(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              No price on file for {unpriced.join(", ")}, so the figure below is not the whole
              bill — this run will cost more than {chosen?.usdLabel ?? "it says"}. Start anyway.
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button
            size="lg"
            variant="primary"
            icon={<IconPlay size="sm" />}
            loading={starting}
            disabled={!canStart}
            onClick={() => onStart({ episodeId, model, twins, ticks })}
          >
            {chosen ? `Start the day — ≈ ${chosen.usdLabel}` : "Start the day"}
          </Button>

          {/* The cheap path, one press away from wherever the panel happens to
              be set. Offered beside the full day rather than instead of it. */}
          {ticks === SMOKE_TICKS ? null : (
            <Button
              size="lg"
              variant="secondary"
              disabled={!canStart}
              onClick={() => onStart({ episodeId, model, twins, ticks: SMOKE_TICKS })}
            >
              Smoke test — {SMOKE_TICKS} ticks{smoke ? `, ≈ ${smoke.usdLabel}` : ""}
            </Button>
          )}

          <p className="max-w-[46ch] text-[12px] leading-[18px] text-sn-subtle">
            {twins.length === 0
              ? "Give the agent at least one app — it has to have somewhere to work."
              : blocked
                ? "Working out what this run will cost…"
                : // Stop, not pause: a day is a chain of live model calls, and
                  // there is no point between them to hold one open at.
                  `${ticks} ticks across ${twins.length} app${twins.length === 1 ? "" : "s"}, about ${chosen?.calls ?? 0} model calls. You can stop it at any point.`}
          </p>
        </div>

        {chosen ? (
          <p className="mt-3 text-[11.5px] leading-[17px] text-sn-subtle">
            Covers the agent, the director ({priced?.harness.director}) and the judge (
            {priced?.harness.judge}).{" "}
            {chosen.cachePriced
              ? // The band is the measured spread, not a confidence flourish. Two
                // days of the same length on different scenarios cost 2x apart,
                // because scenarios differ in how much inbox there is to read.
                "Fitted against Sonata's own saved runs, which land within about 25% either side of it — scenarios vary in how much there is to read."
              : // The fit is Anthropic-only, because every run Sonata has measured
                // is one. Claiming the same accuracy for the rest would be the
                // exact move this panel exists to stop.
                "Every run Sonata has measured is on an Anthropic model, where the harness caches the prompt. This one is priced with no caching at all, so read it as a ceiling rather than a fit."}{" "}
            The figure you are billed comes back from OpenRouter when the day ends, and that is
            the one the report shows.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** The model select's optgroups. Order follows the catalog, not the alphabet. */
function byVendor(): [string, (typeof MODEL_CATALOG)[number][]][] {
  const groups = new Map<string, (typeof MODEL_CATALOG)[number][]>();
  for (const option of MODEL_CATALOG) {
    groups.set(option.vendor, [...(groups.get(option.vendor) ?? []), option]);
  }
  return [...groups.entries()];
}
