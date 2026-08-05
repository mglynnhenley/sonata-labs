"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
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
import { useGo } from "../../_components/useGo";
import { apiSend } from "../../api/_lib/client";
import { DAY_LENGTHS, type EpisodeRecord, type ScenarioDraft } from "../../api/_lib/types";
import { BRIEF_EXAMPLES } from "../_lib/examples";
import { ScenarioPreview } from "./ScenarioPreview";

// The product's first promise: one description in, a whole fake company out.
//
// Three steps and no forms: describe it, look at what will be built, create it.
// The preview is generated once and parked as a draft, so Create commits exactly
// what was on screen — the preview and the thing that gets built can never
// disagree, and looking twice never costs twice.

/** The one way a failed generation is reported, on either step. */
function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-sn-lg border border-sn-failed-line bg-sn-failed-soft px-4 py-3">
      <IconAlert size={15} className="mt-0.5 shrink-0 text-sn-danger" />
      <p className="text-[13px] leading-[20px] text-sn-failed-ink">{message}</p>
    </div>
  );
}

/** Shown in order while the company is being written. The wait is real work. */
const WORKING_LINES = [
  "Reading your description…",
  "Hiring the cast, and giving everyone a voice…",
  "Opening the Slack channels they actually use…",
  "Writing the day, beat by beat…",
  "Deciding what counts as having done the job…",
];

export function NewScenarioComposer() {
  const router = useRouter();
  const go = useGo();
  const { toast } = useToast();

  const [brief, setBrief] = useState("");
  const [ticks, setTicks] = useState<number>(DAY_LENGTHS[1]?.ticks ?? 24);
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [working, setWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState(0);

  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!working) {
      setLine(0);
      return;
    }
    // The last line stays put rather than looping: a cycling list reads as a
    // fake progress bar, and this one is telling the truth about the order.
    const timer = setInterval(
      () => setLine((current) => Math.min(current + 1, WORKING_LINES.length - 1)),
      1800,
    );
    return () => clearInterval(timer);
  }, [working]);

  const tooShort = brief.trim().length < 12;

  async function preview() {
    setWorking(true);
    setError(null);
    try {
      const { draft: next } = await apiSend<{ draft: ScenarioDraft }>(
        "/api/worlds/preview",
        "POST",
        { brief: brief.trim(), ticks },
      );
      setDraft(next);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
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
        title: `"${episode.title}" is ready`,
        description: `${draft.business.name} now exists in all three clones. Pick a model and start the day.`,
        tone: "success",
      });
      router.push(`/runs?scenario=${encodeURIComponent(episode.id)}`);
    } catch (err) {
      setCreating(false);
      toast({ title: "Could not create it", description: (err as Error).message, tone: "error" });
    }
  }

  function useExample(text: string) {
    setBrief(text);
    box.current?.focus();
  }

  if (draft) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Step 2 of 2 · Preview"
          title="Here is what will be built"
          subtitle="Nothing has been written yet. Look it over — the counts below are exactly what the seeder will put into Gmail, Slack and the calendar."
          actions={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Change the description
              </Button>
              <Button variant="secondary" loading={working} onClick={() => void preview()}>
                Try again
              </Button>
              <Button
                variant="primary"
                size="lg"
                iconRight={<IconArrowRight size={15} />}
                loading={creating}
                onClick={() => void create()}
              >
                Create scenario
              </Button>
            </>
          }
        />

        {/* "Try again" lives on this step too, so its failure has to be
            reportable here — otherwise the button spins, stops, and nothing
            visible happens. */}
        {error ? <ErrorNote message={error} /> : null}

        <ScenarioPreview draft={draft} />

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-sn-line pt-6">
          <p className="mr-auto max-w-[52ch] text-[13px] leading-[20px] text-sn-muted">
            Creating it saves the company and the day. You can run it straight away, and run it
            again later on a different model to compare.
          </p>
          <Button
            variant="primary"
            size="lg"
            iconRight={<IconArrowRight size={15} />}
            loading={creating}
            onClick={() => void create()}
          >
            Create scenario
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8">
      <PageHeader
        eyebrow="Step 1 of 2 · Describe"
        title="New scenario"
        subtitle="Say what the business is and what happens today, in plain language. Sonata writes the people, their inbox, their channels and their calendar — and the day that unfolds inside them."
        actions={
          <Button variant="ghost" onClick={(e) => go(e, "/scenarios")}>
            Cancel
          </Button>
        }
      />

      <Card padding="lg">
        <label htmlFor="brief" className="text-[13px] font-medium text-sn-ink">
          Describe the business and what happens today
        </label>
        <textarea
          id="brief"
          ref={box}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={6}
          autoFocus
          disabled={working}
          placeholder="A 12-person fintech, the week before an audit. This morning the biggest client escalates about a missed SLA, and the answer is buried in a Slack thread nobody has read."
          className={cn(
            "mt-2.5 w-full resize-y rounded-sn-lg border border-sn-line bg-sn-surface px-4 py-3.5",
            "text-[15px] leading-[24px] text-sn-ink shadow-sn-xs placeholder:text-sn-subtle",
            "transition-colors duration-150 ease-sn hover:border-sn-line-strong disabled:opacity-60",
          )}
        />

        <div className="mt-4">
          <p className="text-[12px] text-sn-subtle">Or start from one of these:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {BRIEF_EXAMPLES.map((example) => (
              <Chip
                key={example.label}
                tone="gold"
                icon={<IconSpark size={12} />}
                onClick={() => useExample(example.text)}
              >
                {example.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-7 border-t border-sn-line pt-5">
          <p className="text-[13px] font-medium text-sn-ink">How long the day should run</p>
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

        {error ? (
          <div className="mt-6">
            <ErrorNote message={error} />
          </div>
        ) : null}

        <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-sn-line pt-5">
          <Button
            size="lg"
            variant="primary"
            icon={<IconSpark size={14} />}
            loading={working}
            disabled={tooShort}
            onClick={() => void preview()}
          >
            Preview what gets built
          </Button>
          {working ? (
            <span className="flex items-center gap-2.5 text-[13px] text-sn-muted">
              <Spinner size="sm" />
              {WORKING_LINES[line]}
            </span>
          ) : (
            <p className="text-[12px] leading-[18px] text-sn-subtle">
              {tooShort
                ? "A sentence or two is enough — who the company is, and what goes wrong today."
                : "Nothing is written until you have seen the preview and pressed Create."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
