"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Button,
  buttonClasses,
  Card,
  Chip,
  IconAlert,
  IconArrowRight,
  IconSpark,
  PageHeader,
  Spinner,
  cn,
  useToast,
} from "@sonata/ui";
import { scrollBehavior } from "../../_components/scrollBehavior";
import { useGo } from "../../_components/useGo";
import { apiSend } from "../../api/_lib/client";
import { track } from "@/lib/track";
import {
  DAY_LENGTHS,
  type EpisodeRecord,
  type ScenarioDraft,
  type TemplateSummary,
} from "../../api/_lib/types";
import { BRIEF_EXAMPLES } from "../_lib/examples";
import { episodeFromTemplate } from "../_lib/shipped";
import { ScenarioPreview } from "./ScenarioPreview";

// Keep one generation path: the description and optional expectations form a
// single brief. Save commits the exact draft the user reviewed.

/**
 * The one way a failed generation is reported, on either step.
 *
 * The shipped days come with it, always. When the failure is "no model, and
 * nothing shipped resembles what you described", these ARE the remaining
 * options and the point is that the user picks one rather than being handed one;
 * when it is anything else, offering them costs a sentence and claims nothing.
 */
function PreviewFailure({
  message,
  templates,
  busyId,
  onUse,
}: {
  message: string;
  templates: readonly TemplateSummary[];
  busyId: string | null;
  onUse: (template: TemplateSummary) => void;
}) {
  return (
    <div className="sn-stack-block">
      <div className="flex items-start gap-2.5 rounded-sn-lg border border-sn-failed-line bg-sn-failed-soft px-4 py-3">
        <IconAlert size="md" className="mt-0.5 shrink-0 text-sn-danger" />
        <div><p className="text-sn-base text-sn-failed-ink" role="alert">{message}</p>
          <Link href="/scenarios" className="mt-2 inline-block text-sn-sm underline">Open saved scenarios</Link></div>
      </div>

      <Card padding="lg">
        <h3 className="font-display text-sn-xl text-sn-ink">Choose a ready-made scenario</h3>
        <p className="mt-1.5 max-w-[70ch] text-sn-base text-sn-muted">
          These examples have their own business, events and rubric. Choosing one saves that
          example for review; it does not generate the business you described.
        </p>
        <ul className="mt-4 flex flex-col divide-y divide-sn-line">
          {templates.map((template) => (
            <li
              key={template.id}
              className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3.5 first:pt-0 last:pb-0"
            >
              <span className="min-w-[16rem] flex-1">
                <span className="block text-sn-base font-medium text-sn-ink">{template.title}</span>
                <span className="mt-0.5 block text-sn-sm leading-[19px] text-sn-subtle">
                  {template.description}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={busyId === template.id}
                disabled={busyId !== null && busyId !== template.id}
                iconRight={<IconArrowRight size="sm" />}
                onClick={() => onUse(template)}
              >
                Use this example
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export type NewScenarioComposerProps = {
  /** The shipped days, offered as a choice when a description cannot be answered. */
  templates: TemplateSummary[];
};

export function NewScenarioComposer({ templates }: NewScenarioComposerProps) {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();

  const [brief, setBrief] = useState("");
  const [expectations, setExpectations] = useState("");
  const [ticks, setTicks] = useState<number>(DAY_LENGTHS[1]?.ticks ?? 24);
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [working, setWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingShipped, setUsingShipped] = useState<string | null>(null);

  const box = useRef<HTMLTextAreaElement | null>(null);

  const tooShort = brief.trim().length < 12;

  async function preview() {
    setWorking(true);
    setError(null);
    try {
      const { draft: next } = await apiSend<{ draft: ScenarioDraft }>(
        "/api/worlds/preview",
        "POST",
        {
          brief: [
            brief.trim(),
            expectations.trim()
              ? `What the agent should achieve or avoid (use this to shape the scenario and its success criteria):\n${expectations.trim()}`
              : null,
          ].filter(Boolean).join("\n\n"),
          ticks,
        },
      );
      setDraft(next);
      track("scenario_previewed", { ticks, input_chars: brief.trim().length, with_expectations: expectations.trim().length > 0, ok: true });
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
    } catch (err) {
      track("scenario_previewed", { ticks, input_chars: brief.trim().length, with_expectations: expectations.trim().length > 0, ok: false });
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function create() {
    if (!draft) return;
    setCreating(true);
    try {
      const { episode } = await apiSend<{ episode: EpisodeRecord }>("/api/episodes", "POST", {
        draftId: draft.draftId,
      });
      toast({
        title: `"${episode.title}" saved`,
        description: "Review the rubric before choosing a model and running the scenario.",
        tone: "success",
      });
      track("scenario_saved", { episode_id: episode.id, ticks });
      router.push(`/scenarios/${encodeURIComponent(episode.id)}`);
    } catch (err) {
      setCreating(false);
      toast({ title: "Could not save scenario", description: (err as Error).message, tone: "error" });
    }
  }

  async function useShipped(template: TemplateSummary) {
    setUsingShipped(template.id);
    try {
      const episode = await episodeFromTemplate(template.id);
      track("scenario_from_template", { template_id: template.id });
      router.push(`/scenarios/${encodeURIComponent(episode.id)}`);
    } catch (err) {
      setUsingShipped(null);
      toast({ title: "That didn't work", description: (err as Error).message, tone: "error" });
    }
  }

  function useExample(text: string, expectedBehavior: string) {
    setBrief(text);
    setExpectations(expectedBehavior);
    box.current?.focus();
  }

  if (draft) {
    return (
      <div className="sn-stack-section">
        <PageHeader
          eyebrow="New scenario · Preview"
          title="Does this test what you intended?"
          subtitle="Review the environment, the situation and what success looks like. Save this draft to edit its rubric before running an agent."
          actions={
            <>
              <Button variant="ghost" disabled={working || creating} onClick={() => setDraft(null)}>
                Change the description
              </Button>
              <Button variant="secondary" loading={working} disabled={creating} onClick={() => void preview()}>
                Generate another draft
              </Button>
              <Button
                variant="primary"
                size="lg"
                iconRight={<IconArrowRight size="md" />}
                loading={creating}
                disabled={working}
                onClick={() => void create()}
              >
                Save and review rubric
              </Button>
            </>
          }
        />

        {/* "Try again" lives on this step too, so its failure has to be
            reportable here — otherwise the button spins, stops, and nothing
            visible happens. */}
        {error ? (
          <PreviewFailure
            message={error}
            templates={templates}
            busyId={usingShipped}
            onUse={(template) => void useShipped(template)}
          />
        ) : null}

        {working ? (
          <p role="status" className="flex items-center gap-2.5 text-sn-base text-sn-muted">
            <Spinner size="sm" /> Generating another scenario and rubric…
          </p>
        ) : null}

        <ScenarioPreview draft={draft} />

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-sn-line pt-6">
          <p className="mr-auto max-w-[52ch] text-sn-base text-sn-muted">
            Saving keeps this scenario and its rubric. Review the grading details next, then
            choose a model when you are ready to run.
          </p>
          <Button
            variant="primary"
            size="lg"
            iconRight={<IconArrowRight size="md" />}
            loading={creating}
            disabled={working}
            onClick={() => void create()}
          >
            Save and review rubric
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="sn-stack-section mx-auto w-full max-w-[820px]">
      <PageHeader
        eyebrow="New scenario · Describe"
        title="What do you want to test?"
        subtitle="Describe a business and a situation for an agent to handle. Sonata proposes the environment, the scenario and a rubric you can review."
        actions={
          <a href="/scenarios" onClick={(e) => go(e, "/scenarios")} className={buttonClasses("ghost", "md")}>
            Cancel
          </a>
        }
      />

      <Card padding="lg">
        <label htmlFor="brief" className="text-sn-base font-medium text-sn-ink">
          What is the business, and what happens?
        </label>
        <textarea
          id="brief"
          ref={box}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={6}
          autoFocus
          disabled={working}
          aria-describedby="brief-hint"
          placeholder="A support team at a software company. An outage looks resolved in the morning, but returns after lunch while the agent is handling other customer requests."
          className={cn(
            "mt-2.5 w-full resize-y rounded-sn-lg border border-sn-line bg-sn-surface px-4 py-3.5",
            "text-sn-md leading-[24px] text-sn-ink shadow-sn-xs placeholder:text-sn-subtle",
            "transition-colors duration-150 ease-sn hover:border-sn-line-strong disabled:opacity-60",
          )}
        />

        <p id="brief-hint" className="mt-2 text-sn-sm text-sn-subtle">
          The environment is the company, people and apps. The scenario is the situation that unfolds inside it.
        </p>

        <div className="mt-5">
          <label htmlFor="expectations" className="text-sn-base font-medium text-sn-ink">
            What should the agent achieve or avoid? <span className="font-normal text-sn-subtle">Optional</span>
          </label>
          <textarea
            id="expectations"
            value={expectations}
            onChange={(e) => setExpectations(e.target.value)}
            rows={3}
            disabled={working}
            aria-describedby="expectations-hint"
            placeholder="Recheck the incident, update affected customers and keep routine requests moving. Never claim recovery without evidence."
            className="mt-2.5 w-full resize-y rounded-sn-lg border border-sn-line bg-sn-surface px-4 py-3 text-sn-base text-sn-ink placeholder:text-sn-subtle disabled:opacity-60"
          />
          <p id="expectations-hint" className="mt-2 text-sn-sm text-sn-subtle">
            Mention outcomes, deadlines or boundaries. Leave this blank to have Sonata suggest them.
          </p>
        </div>

        <div className="mt-5">
          <p className="text-sn-sm text-sn-subtle">Or try an example:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {BRIEF_EXAMPLES.map((example) => (
              <Chip
                key={example.label}
                tone="gold"
                icon={<IconSpark size="xs" />}
                onClick={() => { if (!working) useExample(example.text, example.expectations); }}
              >
                {example.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-6 border-t border-sn-line pt-5">
          <p className="text-sn-base font-medium text-sn-ink">How much simulated time?</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {DAY_LENGTHS.map((length) => (
              <button
                key={length.ticks}
                type="button"
                disabled={working}
                aria-pressed={ticks === length.ticks}
                onClick={() => setTicks(length.ticks)}
                className={cn(
                  "rounded-sn-md border px-3 py-2 text-left transition-colors duration-150 ease-sn",
                  ticks === length.ticks
                    ? "border-sn-primary bg-sn-primary-soft text-sn-primary-ink"
                    : "border-sn-line bg-sn-surface text-sn-muted hover:border-sn-line-strong",
                )}
              >
                <span className="block text-sn-base font-medium">{length.label}</span>
                {/* Follows the button's state: neutral grey on the pale petrol
                    of a selected chip measures 4.26:1, under AA at 11px. */}
                <span
                  className={cn(
                    "block text-sn-xs",
                    ticks === length.ticks ? "text-sn-primary-ink/85" : "text-sn-subtle",
                  )}
                >
                  {length.hint}
                </span>
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mt-6">
            <PreviewFailure
              message={error}
              templates={templates}
              busyId={usingShipped}
              onUse={(template) => void useShipped(template)}
            />
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-sn-line pt-5">
          <Button
            size="lg"
            variant="primary"
            icon={<IconSpark size="sm" />}
            loading={working}
            disabled={tooShort}
            onClick={() => void preview()}
          >
            Generate scenario and rubric
          </Button>
          {working ? (
            <span role="status" className="flex items-center gap-2.5 text-sn-base text-sn-muted">
              <Spinner size="sm" />
              Generating your scenario and rubric…
            </span>
          ) : (
            <p className="text-sn-sm text-sn-subtle">
              {tooShort
                ? "A sentence or two is enough to begin."
                : "Uses your configured model. Review the draft before saving; no agent run starts here."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
