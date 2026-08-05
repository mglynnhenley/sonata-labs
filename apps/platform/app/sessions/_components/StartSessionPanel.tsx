"use client";

import { useMemo, useState } from "react";
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
import {
  COMPRESSIONS,
  DEFAULT_COMPRESSION_FACTOR,
  type SessionScenario,
  type StartSessionInput,
} from "../../api/sessions/_lib/types";
import { realDuration } from "../_lib/pulse";

// Two choices and a button: which day, and how fast it plays.
//
// There is no model to pick — that is the whole difference between this and a
// run. The agent is already alive somewhere else, and the only thing Sonata
// decides about it is what to call it on the record.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-[13px] text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

export type StartSessionPanelProps = {
  scenarios: readonly SessionScenario[];
  starting: boolean;
  onStart: (input: StartSessionInput) => void;
};

export function StartSessionPanel({ scenarios, starting, onStart }: StartSessionPanelProps) {
  const [episodeId, setEpisodeId] = useState(scenarios[0]?.id ?? "");
  const [compression, setCompression] = useState(DEFAULT_COMPRESSION_FACTOR);
  const [agentLabel, setAgentLabel] = useState("");

  const scenario = useMemo(
    () => scenarios.find((s) => s.id === episodeId),
    [scenarios, episodeId],
  );

  if (scenarios.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size={20} />}
        title="A session needs a scenario"
        description="A scenario is the day the world will play at your agent: who is in the company, what lands and when, and what counts as having done the job. Save one and this panel fills in."
        hints={[
          "Five ready-made days ship with the product — start from one of those",
          "Or describe your own business in a sentence and let Sonata write it",
        ]}
        action={
          <a href="/scenarios">
            <Button variant="primary" iconRight={<IconArrowRight size={14} />}>
              Browse scenarios
            </Button>
          </a>
        }
      />
    );
  }

  const duration = scenario?.realMs.find((r) => r.factor === compression)?.ms ?? 0;
  const perTick = scenario ? duration / Math.max(1, scenario.ticks) : 0;

  return (
    <Card padding="lg">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <label htmlFor="session-scenario" className="text-[13px] font-medium text-sn-ink">
            The day to play
          </label>
          <select
            id="session-scenario"
            className={cn(CONTROL, "mt-2")}
            value={episodeId}
            onChange={(e) => setEpisodeId(e.target.value)}
          >
            {scenarios.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
          <p className="mt-2 line-clamp-2 text-[12px] leading-[18px] text-sn-muted">
            {scenario?.story ?? "Pick the day your agent will be dropped into."}
          </p>
          {scenario ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {scenario.twins.map((twin) => (
                <Chip key={twin} service={twin} size="sm">
                  {SERVICE_LABELS[twin]}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <label htmlFor="session-agent" className="text-[13px] font-medium text-sn-ink">
            What to call your agent
          </label>
          <input
            id="session-agent"
            className={cn(CONTROL, "mt-2")}
            value={agentLabel}
            placeholder="openclaw@laptop"
            onChange={(e) => setAgentLabel(e.target.value)}
          />
          <p className="mt-2 text-[12px] leading-[18px] text-sn-muted">
            A label, not a model. Sonata never calls your agent and cannot know what it runs on, so
            this is whatever you say it is — and it is what the result is filed under.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <p className="text-[13px] font-medium text-sn-ink">How fast the world plays</p>
        <p className="mt-1 max-w-[70ch] text-[12px] leading-[18px] text-sn-muted">
          The day runs on a wall clock at this rate whether or not your agent is looking. Faster is a
          shorter wait and less time between beats for the agent to notice anything.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {COMPRESSIONS.map((option) => {
            const on = compression === option.factor;
            const ms = scenario?.realMs.find((r) => r.factor === option.factor)?.ms ?? 0;
            return (
              <button
                key={option.factor}
                type="button"
                aria-pressed={on}
                onClick={() => setCompression(option.factor)}
                className={cn(
                  "rounded-sn-md border px-3 py-2.5 text-left transition-colors duration-150 ease-sn",
                  on
                    ? "border-sn-primary bg-sn-primary-soft text-sn-primary-ink"
                    : "border-sn-line bg-sn-surface text-sn-muted hover:border-sn-line-strong",
                )}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium">{option.label}</span>
                  <span data-numeric className="text-[12px]">
                    {realDuration(ms)}
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-[17px] text-sn-subtle">
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-sn-line pt-5">
        <Button
          size="lg"
          variant="primary"
          icon={<IconPlay size={13} />}
          loading={starting}
          disabled={!episodeId}
          onClick={() =>
            onStart({
              episodeId,
              compression,
              ...(agentLabel.trim() ? { agentLabel: agentLabel.trim() } : {}),
            })
          }
        >
          Start the world
        </Button>
        <p className="max-w-[54ch] text-[12px] leading-[18px] text-sn-subtle">
          {scenario
            ? `${scenario.ticks} intervals of ${scenario.simMinutesPerTick} simulated minutes — about ${realDuration(duration)} of real time, a beat every ${realDuration(perTick)}. The clones are reset and reloaded first, so connect your agent once the day is running.`
            : "Pick a day to see how long it takes."}
        </p>
      </div>
    </Card>
  );
}
