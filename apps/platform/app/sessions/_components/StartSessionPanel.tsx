"use client";

import { useMemo, useState } from "react";
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
import {
  COMPRESSIONS,
  type SessionScenario,
  type StartSessionInput,
} from "../../api/sessions/_lib/types";
import { realDuration } from "../_lib/pulse";

// Browser sessions are manual tests. Model runs connect through Inspect on /runs.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-sn-base text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

export type StartSessionPanelProps = {
  scenarios: readonly SessionScenario[];
  starting: boolean;
  onStart: (input: StartSessionInput) => void;
  /** URL presets make `/sessions?mode=manual&scenario=…` a ready-to-use test page. */
  initialEpisodeId?: string;
};

export function StartSessionPanel({
  scenarios,
  starting,
  onStart,
  initialEpisodeId,
}: StartSessionPanelProps) {
  const selected = scenarios.some((scenario) => scenario.id === initialEpisodeId)
    ? initialEpisodeId!
    : scenarios[0]?.id ?? "";
  const [episodeId, setEpisodeId] = useState(selected);
  const [compression, setCompression] = useState(12);
  const [testerName, setTesterName] = useState("");

  const scenario = useMemo(
    () => scenarios.find((s) => s.id === episodeId),
    [scenarios, episodeId],
  );

  if (scenarios.length === 0) {
    return (
      <EmptyState
        icon={<IconLayers size="lg" />}
        title="A session needs a scenario"
        description="A scenario is the day the world will play at your agent: who is in the company, what lands and when, and what counts as having done the job. Save one and this panel fills in."
        hints={[
          "Five ready-made days ship with the product — start from one of those",
          "Or describe your own business in a sentence and let Sonata write it",
        ]}
        action={
          <a href="/scenarios" className={buttonClasses("primary", "md")}>
            Browse scenarios
            <IconArrowRight size="sm" />
          </a>
        }
      />
    );
  }

  const duration = scenario?.realMs.find((r) => r.factor === compression)?.ms ?? 0;

  return (
    <Card
      padding="lg"
      title="Start a manual test"
      subtitle="You work directly in the browser apps. Scripted events still arrive and every saved change goes into the report."
    >
      <div>
        <p className="text-sn-base font-medium text-sn-ink">Who is doing the work?</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div
            className="rounded-sn-md border border-sn-primary bg-sn-primary-soft px-3.5 py-3 text-left text-sn-primary-ink"
          >
            <span className="block text-sn-base font-medium">Me, in the browser</span>
            <span className="mt-1 block text-sn-sm">No model calls or model cost. You use the linked Gmail, Slack, Calendar and Excel screens.</span>
          </div>
          <a
            href={`/runs?scenario=${encodeURIComponent(episodeId)}`}
            className="rounded-sn-md border border-sn-line bg-sn-surface px-3.5 py-3 text-left text-sn-muted transition-colors duration-150 ease-sn hover:border-sn-line-strong"
          >
            <span className="block text-sn-base font-medium">AI with Inspect</span>
            <span className="mt-1 block text-sn-sm">Choose a model and review its run settings. Inspect connects the agent to its private apps.</span>
          </a>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <label htmlFor="session-scenario" className="text-sn-base font-medium text-sn-ink">
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
          <p className="mt-2 line-clamp-2 text-sn-sm text-sn-muted">
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
          <label htmlFor="session-agent" className="text-sn-base font-medium text-sn-ink">
            Who is testing
          </label>
          <input
            id="session-agent"
            className={cn(CONTROL, "mt-2")}
            value={testerName}
            placeholder="Your name (optional)"
            onChange={(e) => setTesterName(e.target.value)}
          />
          <p className="mt-2 text-sn-sm text-sn-muted">
            This appears on the session and report so the manual run is easy to recognise.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <p className="text-sn-base font-medium text-sn-ink">How fast the world plays</p>
        <p className="mt-1 max-w-[70ch] text-sn-sm text-sn-muted">
          The day keeps moving at this rate while you work. Faster settings leave less time
          between incoming events.
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
                  <span className="text-sn-base font-medium">{option.label}</span>
                  <span data-numeric className="text-sn-sm">
                    {realDuration(ms)}
                  </span>
                </span>
                {/* The hint has to follow the button's own state. Hardcoded
                    neutral grey measures 4.26:1 once the surface turns pale
                    petrol, which is under AA at 11px. */}
                <span
                  className={cn(
                    "mt-0.5 block text-sn-xs",
                    on ? "text-sn-primary-ink/85" : "text-sn-subtle",
                  )}
                >
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
          icon={<IconPlay size="sm" />}
          loading={starting}
          disabled={!episodeId}
          onClick={() =>
            onStart({
              episodeId,
              compression,
              agentLabel: `Manual browser test${testerName.trim() ? ` · ${testerName.trim()}` : ""}`,
              director: false,
              judge: false,
            })
          }
        >
          Start manual test
        </Button>
        <p className="max-w-[54ch] text-sn-sm text-sn-subtle">
          {scenario
            ? `${scenario.ticks} intervals of ${scenario.simMinutesPerTick} simulated minutes — about ${realDuration(duration)} of real time. A private workplace is prepared when you start, then its apps open from the live session page. Model colleagues and the narrative judge stay off.`
            : "Pick a day to see how long it takes."}
        </p>
      </div>
    </Card>
  );
}
