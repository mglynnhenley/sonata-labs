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
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-sn-base text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

/** Select sentinel for the free-text model input — never a real model id. */
const CUSTOM_MODEL = "__other-model__";

/** The charge allowance Stage 3's comparison used as its middle profile. */
const DEFAULT_WORK_UNITS = 12;

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
  /** Whether an OpenRouter key is saved. Without one, a run dies on its first model call. */
  hasKey: boolean;
  onStart: (input: StartRunInput) => void;
};

export function StartRunPanel({
  episodes,
  defaultModel,
  beatTicks,
  initialEpisodeId,
  starting,
  hasKey,
  onStart,
}: StartRunPanelProps) {
  const first = initialEpisodeId ?? episodes[0]?.id ?? "";
  const initialEpisode = episodes.find((item) => item.id === first);
  const [episodeId, setEpisodeId] = useState(first);
  const [model, setModel] = useState(defaultModel);
  const [customModel, setCustomModel] = useState(false);
  const [ticks, setTicks] = useState<number>(initialEpisode?.counts.ticks ?? SMOKE_TICKS);
  const [twins, setTwins] = useState<TwinName[]>(initialEpisode?.twins ?? []);
  const [priced, setPriced] = useState<RunEstimateResponse | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [estimateAttempt, setEstimateAttempt] = useState(0);
  const [spendAnyway, setSpendAnyway] = useState(false);
  const [spendLimit, setSpendLimit] = useState("");
  // Stage 3 left the compressed clock as the default and the operation charge as
  // an experiment, so this is a two-value choice and not a general clock editor.
  const [clock, setClock] = useState<"compressed-wall-time" | "provider-operations-v1">("compressed-wall-time");
  const [workUnits, setWorkUnits] = useState(String(DEFAULT_WORK_UNITS));

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
    setPriced(null);
    setPricingError(null);
    setSpendAnyway(false);
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
  }, [model, lengthKey, estimateAttempt]);

  const estimateFor = (n: number): RunEstimate | undefined =>
    priced?.estimates.find((e) => e.ticks === n && e.model === model);
  const chosen = estimateFor(ticks);
  const smoke = estimateFor(SMOKE_TICKS);

  if (episodes.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size="lg" />}
        title="A run needs a scenario"
        description="A scenario is one simulated workday: who is in the company, what happens and when, and what counts as having done the job. Save one and this panel fills in."
        hints={[
          "Choose an example scenario and review what success looks like",
          "Or describe your own business in a sentence and let Sonata write it",
        ]}
        action={
          <a href="/scenarios" className={buttonClasses("primary", "md")}>
            See the scenarios
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
  const blocked = !chosen;
  const needsConsent = unpriced.length > 0 && !spendAnyway;
  const budgetValid = spendLimit.trim() === "" || (Number.isFinite(Number(spendLimit)) && Number(spendLimit) > 0);
  const runBudget = spendLimit.trim() === "" ? {} : { termination: { maxCostUsd: Number(spendLimit) } };
  // Mirrors `normalizeSessionTiming`, which is the one that actually decides —
  // this only keeps the button from posting a body the API will refuse.
  const units = Number(workUnits);
  const clockValid = clock === "compressed-wall-time" ||
    (Number.isInteger(units) && units >= 1 && units <= 10_000);
  const runTiming: Pick<StartRunInput, "timing"> = clock === "compressed-wall-time"
    ? {}
    : { timing: { policy: "provider-operations-v1", workUnitsPerTick: units } };
  const canStart = Boolean(episodeId) && twins.length > 0 && !blocked && !needsConsent && budgetValid && clockValid;

  return (
    // The panel names itself — the page used to carry an h2 above it, and on a
    // dashboard every panel is a titled card instead.
    <Card
      padding="lg"
      title="Start a run"
      subtitle={
        clock === "compressed-wall-time"
          ? "Choose the model to run through Inspect. Sonata supplies the workplace, colleagues and grading. The clock advances one simulated hour per real minute."
          : "Choose the model to run through Inspect. Sonata supplies the workplace, colleagues and grading. The clock advances on the agent's own app requests, not on elapsed real time."
      }
    >
      {/* Only the two selects are peers, so only they pair off. Beside the lengths
          — three priced buttons, a tick box and a truncation notice — the chip row
          ran out about 150px short and left the start button below a hole. The two
          button groups take the whole card instead, which is also what lets the
          lengths sit three across rather than wrapping two-then-one. */}
      <div className="sn-stack-block">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <label htmlFor="run-scenario" className="text-sn-base font-medium text-sn-ink">
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
            <p className="mt-2 line-clamp-2 text-sn-sm text-sn-muted">
              {episode?.story ?? "Pick the day you want to test against."}
            </p>
            {episode ? (
              <p className="mt-2 text-sn-sm text-sn-muted">
                Environment: {episode.worldName}{" · "}
                <a href={`/scenarios/${encodeURIComponent(episode.id)}`}
                  className="font-medium text-sn-primary-ink hover:underline">
                  Review scenario and expectations
                </a>
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="run-model" className="text-sn-base font-medium text-sn-ink">
              Model under test
            </label>
            <select
              id="run-model"
              className={cn(CONTROL, "mt-2")}
              value={customModel ? CUSTOM_MODEL : model}
              onChange={(e) => {
                if (e.target.value === CUSTOM_MODEL) {
                  setCustomModel(true);
                } else {
                  setCustomModel(false);
                  setModel(e.target.value);
                }
              }}
            >
              {chosenModel || customModel ? null : <option value={model}>{model}</option>}
              {byVendor().map(([vendor, models]) => (
                <optgroup key={vendor} label={vendor}>
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={CUSTOM_MODEL}>Other — type a model id…</option>
            </select>
            {customModel ? (
              <input
                type="text"
                className={cn(CONTROL, "mt-2")}
                placeholder="google/gemma-3-27b-it, or a local Ollama tag like gemma3"
                value={model}
                onChange={(e) => setModel(e.target.value.trim())}
                aria-label="Custom model id"
              />
            ) : null}
            <p className="mt-2 text-sn-sm text-sn-muted">
              {chosenModel
                ? `${chosenModel.note} · ${usd(chosenModel.inputUsd)} in / ${usd(chosenModel.outputUsd)} out per million tokens`
                : customModel
                  ? "An OpenRouter id — or, with OPENROUTER_BASE_URL pointed at a local server, whatever model that server hosts. No price on file, so the cost figures go blank."
                  : "An OpenRouter model id."}
            </p>
          </div>
        </div>

        <div>
          <p className="text-sn-base font-medium text-sn-ink">Apps available to the agent</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {twins.map((twin) => <Chip key={twin} service={twin} size="sm">{SERVICE_LABELS[twin]}</Chip>)}
            {twins.length === 0 ? <span className="text-sn-sm text-sn-muted">No apps selected</span> : null}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-sn-sm font-medium text-sn-muted">Change app access</summary>
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
          <p className="mt-2 max-w-[76ch] text-sn-sm text-sn-muted">
            These apps come from the scenario. Changing access changes the conditions of the test.
          </p>
          </details>

          <div className="mt-4">
            <label htmlFor="run-spend-limit" className="text-sn-sm font-medium text-sn-ink">Spending limit (USD)</label>
            <input id="run-spend-limit" type="number" min="0.01" step="0.01"
              value={spendLimit} onChange={(event) => setSpendLimit(event.target.value)}
              placeholder="Use scenario limit" className={`${CONTROL} mt-2 max-w-xs`} />
            <p className="mt-2 text-sn-xs text-sn-muted">
              Covers the agent and colleagues. Final judging is additional. Checked after calls finish;
              an in-flight call can exceed the limit. Leave blank to use the scenario's limit.
            </p>
          </div>

          {/* Folded away because the answer is the default for every run that
              isn't the timing experiment itself — and because the two clocks are
              different experimental conditions, so results under them are not
              comparable and the panel should not invite a casual swap. */}
          <details className="mt-4">
            <summary className="cursor-pointer text-sn-sm font-medium text-sn-muted">
              How simulated time advances
            </summary>
            <label htmlFor="run-clock" className="sr-only">Clock</label>
            <select
              id="run-clock"
              className={cn(CONTROL, "mt-3 max-w-sm")}
              value={clock}
              onChange={(event) => setClock(event.target.value as typeof clock)}
            >
              <option value="compressed-wall-time">Compressed real time (default)</option>
              <option value="provider-operations-v1">Charge the agent's app requests (experimental)</option>
            </select>
            {clock === "compressed-wall-time" ? (
              <p className="mt-2 max-w-[76ch] text-sn-xs text-sn-muted">
                One simulated hour per real minute. A slow or retrying provider therefore
                spends business time, so the day measures the whole deployed system under
                time pressure rather than the model's work alone.
              </p>
            ) : (
              <>
                <label
                  htmlFor="run-work-units"
                  className="mt-3 flex flex-wrap items-center gap-2 text-sn-sm text-sn-muted"
                >
                  <span>Allow</span>
                  <input
                    id="run-work-units"
                    type="number"
                    min={1}
                    max={10_000}
                    value={workUnits}
                    onChange={(event) => setWorkUnits(event.target.value)}
                    className="h-8 w-20 rounded-sn-md border border-sn-line bg-sn-surface px-2 text-sn-base tabular-nums text-sn-ink"
                  />
                  <span>work units per 15-minute interval</span>
                </label>
                <p className="mt-2 max-w-[76ch] text-sn-xs text-sn-muted">
                  Each app read costs 1 unit and each write 2, counted by item, so inference
                  latency no longer moves the business clock. The charges are an experimental
                  parameter — no accountant has said a read is worth 75 seconds — and a
                  deadline result under them is only as good as the allowance. Runs on this
                  clock are not comparable with runs on the default.
                </p>
                {clockValid ? null : (
                  <p className="mt-2 text-sn-xs text-sn-danger-ink">
                    The allowance must be a whole number of units from 1 to 10,000.
                  </p>
                )}
              </>
            )}
          </details>
        </div>

        <div>
          {/* The caption sits beside the label, not at the far end of the row: across
              the full card those two ended up a screen apart and stopped reading as
              one thought. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-sn-base font-medium text-sn-ink">How long the day runs</p>
            <p className="text-sn-xs text-sn-subtle">
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
                  <span className="block text-sn-base font-medium">{length.label}</span>
                  {/* Follows the button's state: neutral grey on the pale petrol
                      of a selected chip measures 4.26:1, under AA at 11px. */}
                  <span
                    className={cn("block text-sn-xs", on ? "text-sn-primary-ink/85" : "text-sn-subtle")}
                  >
                    {length.hint}
                  </span>
                  <span
                    data-numeric
                    className={cn(
                      "mt-1 block text-sn-xs tabular-nums",
                      on ? "text-sn-primary-ink" : "text-sn-muted",
                    )}
                  >
                    {price ? `≈ ${price.usdLabel}` : "pricing…"}
                  </span>
                </button>
              );
            })}
          </div>

          <details className="mt-3">
          <summary className="cursor-pointer text-sn-sm font-medium text-sn-muted">Set a custom duration</summary>
          <label
            htmlFor="run-ticks"
            className="mt-3 flex flex-wrap items-center gap-2 text-sn-sm text-sn-muted"
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
              className="h-8 w-20 rounded-sn-md border border-sn-line bg-sn-surface px-2 text-sn-base tabular-nums text-sn-ink"
            />
            <span>ticks of 15 simulated minutes</span>
          </label>
          </details>

          {shortened ? (
            // The honest cost of a short day. The harness already understands
            // this: `runTruncation` marks anything that never fired as OUR
            // defect, not the agent's, so a smoke test cannot quietly invent a
            // failure. Saying so here is what makes the short day usable.
            <p className="mt-3 rounded-sn-md border border-sn-line bg-sn-bg-subtle px-3 py-2 text-sn-sm text-sn-muted">
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
          <div className="mb-4 rounded-sn-md border border-sn-failed-line bg-sn-danger-soft px-3 py-2 text-sn-sm text-sn-danger-ink">
            <p>Could not work out what this run will cost: {pricingError}</p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={() => setEstimateAttempt((value) => value + 1)}>Retry estimate</Button>
          </div>
        ) : null}

        {unpriced.length > 0 ? (
          <label className="mb-4 flex items-start gap-2.5 rounded-sn-md border border-sn-line-strong bg-sn-warning-soft px-3 py-2 text-sn-sm text-sn-warning-ink">
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

        {!hasKey ? (
          <div className="rounded-sn-md border border-sn-warning-line bg-sn-warning-soft px-4 py-3 text-sn-base text-sn-ink">
            No OpenRouter key yet, so nothing can run — the agent, the coworkers and the judge are
            all model calls.{" "}
            <a href="/settings" className="font-semibold underline">
              Add a key in Settings
            </a>{" "}
            first; it takes a minute and the smoke test costs about 13 cents.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button
            size="lg"
            variant="primary"
            icon={<IconPlay size="sm" />}
            loading={starting}
            disabled={!canStart || !hasKey}
            onClick={() => onStart({ episodeId, model, twins, ticks, ...runBudget, ...runTiming })}
          >
            {chosen ? `Start the day — ≈ ${chosen.usdLabel}` : "Start the day"}
          </Button>

          {/* The cheap path, one press away from wherever the panel happens to
              be set. Offered beside the full day rather than instead of it. */}
          {ticks === SMOKE_TICKS ? null : (
            <Button
              size="lg"
              variant="secondary"
              disabled={!canStart || !hasKey}
              onClick={() => onStart({ episodeId, model, twins, ticks: SMOKE_TICKS, ...runBudget, ...runTiming })}
            >
              Smoke test — {SMOKE_TICKS} ticks{smoke ? `, ≈ ${smoke.usdLabel}` : ""}
            </Button>
          )}

          <p className="max-w-[46ch] text-sn-sm text-sn-subtle">
            {twins.length === 0
              ? "Give the agent at least one app — it has to have somewhere to work."
              : blocked
                ? pricingError ? "Retry the cost estimate before starting." : "Working out what this run will cost…"
                : // Stop, not pause: a day is a chain of live model calls, and
                  // there is no point between them to hold one open at.
                  `${ticks} intervals across ${twins.length} app${twins.length === 1 ? "" : "s"}. Setup and grading take additional time. You can stop it at any point.`}
          </p>
        </div>

        {chosen ? (
          <p className="mt-3 text-sn-xs text-sn-subtle">
            Covers the agent, the director ({priced?.harness.director}) and the judge (
            {priced?.harness.judge}).{" "}
            These are planning estimates from Sonata's previous runner; Inspect costs have not
            yet been calibrated. They are not a spending ceiling.{" "}
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
