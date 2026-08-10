"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
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
import { DAY_LENGTHS, type EpisodeSummary, type StartRunInput } from "../../api/_lib/types";

// Everything it takes to start a day, on one card, with no page in between.
// Four choices and a button; the twins and the day length are pre-filled from
// the scenario, so the fast path is pick-a-scenario and press.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-[13px] text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

export type StartRunPanelProps = {
  episodes: readonly EpisodeSummary[];
  /** The agent model from Settings — the choice already made once. */
  defaultModel: string;
  /** Preselected from `?scenario=`, so "Start a run" on a card lands ready. */
  initialEpisodeId?: string;
  starting: boolean;
  onStart: (input: StartRunInput) => void;
};

export function StartRunPanel({
  episodes,
  defaultModel,
  initialEpisodeId,
  starting,
  onStart,
}: StartRunPanelProps) {
  const first = initialEpisodeId ?? episodes[0]?.id ?? "";
  const [episodeId, setEpisodeId] = useState(first);
  const [model, setModel] = useState(defaultModel);
  const [ticks, setTicks] = useState<number>(DAY_LENGTHS[1]?.ticks ?? 24);
  const [twins, setTwins] = useState<TwinName[]>([]);

  const episode = useMemo(
    () => episodes.find((e) => e.id === episodeId),
    [episodes, episodeId],
  );

  // The scenario decides which surfaces matter and how long the day is; picking
  // a different one has to move both, or the run panel quietly lies.
  useEffect(() => {
    if (!episode) return;
    setTwins(episode.twins);
    setTicks(episode.counts.ticks);
  }, [episode]);

  const byVendor = useMemo(() => {
    const groups = new Map<string, typeof MODEL_CATALOG>();
    for (const option of MODEL_CATALOG) {
      groups.set(option.vendor, [...(groups.get(option.vendor) ?? []), option]);
    }
    return [...groups.entries()];
  }, []);

  if (episodes.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size={20} />}
        title="A run needs a scenario"
        description="A scenario is one simulated workday: who is in the company, what happens and when, and what counts as having done the job. Save one and this panel fills in."
        hints={[
          "Five ready-made days ship with the product — start from one of those",
          "Or describe your own business in a sentence and let Sonata write it",
        ]}
        action={
          <a href="/scenarios">
            <Button variant="primary" iconRight={<IconArrowRight size={14} />}>
              See the five scenarios
            </Button>
          </a>
        }
      />
    );
  }

  const chosenModel = findModel(model);

  return (
    <Card padding="lg">
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
            {byVendor.map(([vendor, models]) => (
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
          <p className="mt-2 text-[12px] leading-[18px] text-sn-muted">
            Detach an app to see what the agent does without it — that is the cheapest way to
            find out which surface it was actually relying on.
          </p>
        </div>

        <div>
          <p className="text-[13px] font-medium text-sn-ink">How long the day runs</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {DAY_LENGTHS.map((length) => (
              <button
                key={length.ticks}
                type="button"
                aria-pressed={ticks === length.ticks}
                onClick={() => setTicks(length.ticks)}
                className={cn(
                  "rounded-sn-md border px-3 py-2 text-left transition-colors duration-150 ease-sn",
                  ticks === length.ticks
                    ? "border-sn-primary bg-sn-primary-soft text-sn-primary-ink"
                    : "border-sn-line bg-sn-surface text-sn-muted hover:border-sn-line-strong",
                )}
              >
                <span className="block text-[13px] font-medium">{length.label}</span>
                <span className="block text-[11.5px] text-sn-subtle">{length.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-sn-line pt-5">
        <Button
          size="lg"
          variant="primary"
          icon={<IconPlay size={13} />}
          loading={starting}
          disabled={!episodeId || twins.length === 0}
          onClick={() => onStart({ episodeId, model, twins, ticks })}
        >
          Start the day
        </Button>
        <p className="text-[12px] leading-[18px] text-sn-subtle">
          {twins.length === 0
            ? "Give the agent at least one app — it has to have somewhere to work."
            : // Stop, not pause: a day is a chain of live model calls, and there is
              // no point between them to hold one open at. Promising a pause here
              // was promising a button that answered with a 500.
              `${ticks} ticks of 15 simulated minutes, across ${twins.length} app${twins.length === 1 ? "" : "s"}. You can stop it at any point.`}
        </p>
      </div>
    </Card>
  );
}
