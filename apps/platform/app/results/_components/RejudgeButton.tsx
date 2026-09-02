"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EpisodeJudgeReport } from "@sonata/core";
import { Button, Chip, IconCheck, IconSpark, Modal, Spinner, cn } from "@sonata/ui";
import { DEFAULT_MODELS, MODEL_CATALOG, modelLabel } from "@/lib/models";
import { formatPercent, formatUsd, formatWhen } from "../_lib/summary";
import { useJudgeState } from "./judgeState";

// Re-judging is the payoff of keeping everything in the artifact: a run recorded
// months ago can be read again by a different model, with no twin running and no
// agent replayed. Only the judge's half of the verdict changes — the checklist
// is deterministic and stays exactly as it was.
//
// It is a SECOND reading, not the only one. A run judges itself when it ends, so
// this control means "read this day again, with a better model" — which is a real
// feature and the reason it survives. It says "Judge this run" only in the two
// cases where nothing has: a day whose automatic pass fell over, and a day
// recorded before runs judged themselves.
//
// Three states, because pressing this used to look like pressing nothing. A
// judge pass is a minute or more of somebody else's model reading a whole day,
// and the old control closed its dialog the instant it was told to start, put a
// spinner on a button nobody was looking at any more, and refreshed a page whose
// only visible change was a timestamp in small grey type. So the dialog now stays
// put and OWNS the wait — it says which model is reading, counts the seconds, and
// ends by showing what came back. The refresh happens behind it, so the page is
// already current when the reader dismisses the result.

/**
 * Shortcuts, not a whitelist: the box takes any OpenRouter slug, and the point
 * of re-judging is usually to try a model the settings page never picked. One
 * per vendor keeps the row short and the comparison meaningful.
 */
const SUGGESTIONS = [...new Map(MODEL_CATALOG.map((m) => [m.vendor, m.id])).values()];

type Phase =
  | { kind: "form" }
  | { kind: "judging"; model: string }
  | { kind: "done"; report: EpisodeJudgeReport; spendUsd: number | null };

/** Live seconds, so a long wait reads as progress rather than as a hang. */
function useElapsed(since: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (since === null) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - since) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return seconds;
}

export function RejudgeButton({
  runId,
  currentModel,
  variant = "secondary",
}: {
  runId: string;
  /** The model that judged it last, pre-filled so a re-run is one click. */
  currentModel?: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(currentModel ?? DEFAULT_MODELS.judge);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState("");
  const startedAt = useRef<number | null>(null);

  const busy = phase.kind === "judging";
  const elapsed = useElapsed(busy ? startedAt.current : null);
  const state = useJudgeState();

  // A run nobody has judged is not being *re*-judged, and calling it that is how
  // a first-time user concludes they have missed a step somewhere. A run whose
  // own pass FAILED is a third case: there is nothing to re-read, and the honest
  // word for pressing this is "again".
  const first = !currentModel && state?.state !== "failed";
  const retry = state?.state === "failed";
  // A pass already in flight is not something to start a second of.
  const inFlight = state?.state === "judging";

  async function submit() {
    const wanted = model.trim();
    startedAt.current = Date.now();
    setPhase({ kind: "judging", model: wanted });
    setError("");
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(runId)}/rejudge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: wanted }),
      });
      const data = (await res.json()) as {
        error?: string;
        report?: EpisodeJudgeReport;
        spend?: { usd: number | null } | null;
      };
      if (!res.ok || !data.report) {
        throw new Error(data.error || `The judge call failed (HTTP ${res.status}).`);
      }
      setPhase({ kind: "done", report: data.report, spendUsd: data.spend?.usd ?? null });
      // Behind the dialog, so the verdict, the findings and the judged-at line
      // have already changed by the time the reader dismisses this.
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setPhase({ kind: "form" });
    }
  }

  function dismiss() {
    if (busy) return;
    setOpen(false);
    // Reset on the way out, not on the way in: reopening to read the result you
    // just got is a reasonable thing to do, and the dialog should still have it.
    if (phase.kind === "done") setPhase({ kind: "form" });
  }

  const title =
    phase.kind === "judging"
      ? "Judging this run"
      : phase.kind === "done"
        ? "Judged"
        : retry
          ? "Try judging this run again"
          : first
            ? "Judge this run"
            : "Re-judge this run";

  return (
    <>
      {/* A pass already in flight disables the button rather than putting it in
          the loading state, which would hide the label behind a spinner — and the
          label is the whole message. */}
      <Button
        variant={variant}
        icon={<IconSpark size="sm" />}
        loading={busy}
        disabled={inFlight}
        onClick={() => setOpen(true)}
      >
        {inFlight
          ? "A judge is reading this day"
          : retry
            ? "Try judging it again"
            : first
              ? "Judge this run"
              : "Re-judge with another model"}
      </Button>

      <Modal
        open={open}
        onClose={dismiss}
        dismissible={!busy}
        title={title}
        description={
          phase.kind === "done"
            ? "The deterministic checklist is untouched — only the diagnosis below it changed."
            : phase.kind === "judging"
              ? "Nothing is being re-run. The saved day is being read back, start to finish."
              : retry
                ? "This run judged itself when the day ended and that pass did not come back. This is the same reading, attempted again — nothing is re-run, and the checklist is untouched either way."
                : first
                  ? "A model reads the saved day and names what went wrong, with evidence for each finding. Nothing is re-run — the deterministic checklist stays exactly as it is."
                  : "The saved day is read again by a different model. Nothing is re-run: the checklist and the autonomy score are counted off the day itself and stay put — only the diagnosis changes."
        }
        footer={
          phase.kind === "done" ? (
            <Button variant="primary" onClick={dismiss}>
              See it on the page
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={dismiss} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!model.trim()}
                onClick={() => void submit()}
              >
                {busy ? "Judging…" : first ? "Judge it" : retry ? "Try again" : "Judge it again"}
              </Button>
            </>
          )
        }
      >
        {phase.kind === "judging" ? (
          <Waiting model={phase.model} seconds={elapsed} />
        ) : phase.kind === "done" ? (
          <Landed report={phase.report} spendUsd={phase.spendUsd} />
        ) : (
          <>
            <label className="block text-sn-sm font-medium text-sn-ink" htmlFor="rejudge-model">
              Model
            </label>
            <input
              id="rejudge-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              spellCheck={false}
              placeholder="provider/model-slug"
              className={cn(
                "mt-1.5 h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-3 font-mono text-sn-sm text-sn-ink",
                "transition-colors duration-150 ease-sn placeholder:text-sn-subtle hover:border-sn-line-strong",
              )}
            />
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {SUGGESTIONS.map((slug) => (
                <Chip
                  key={slug}
                  size="sm"
                  icon={false}
                  selected={model === slug}
                  onClick={() => setModel(slug)}
                  title={slug}
                >
                  {modelLabel(slug)}
                </Chip>
              ))}
            </div>
            <p className="mt-3 text-sn-sm text-sn-muted">
              Any OpenRouter slug works. The key comes from OPENROUTER_API_KEY on this machine.
              Reading a whole day back takes a minute or two.
            </p>
            {error ? (
              <p className="mt-3 rounded-sn-md border border-sn-failed-line bg-sn-failed-soft p-2.5 text-sn-sm text-sn-failed-ink">
                {error}
              </p>
            ) : null}
          </>
        )}
      </Modal>
    </>
  );
}

function Waiting({ model, seconds }: { model: string; seconds: number }) {
  return (
    <div
      aria-live="polite"
      className="rounded-sn-xl border border-sn-line bg-sn-bg-subtle px-4 py-4 text-sn-base text-sn-muted"
    >
      <div className="flex items-center gap-2.5 text-sn-ink">
        <Spinner size="sm" label="" />
        <span className="font-mono text-sn-sm">{model}</span>
        <span className="text-sn-subtle">is reading the day back</span>
        <span data-numeric className="ml-auto text-sn-sm text-sn-subtle">
          {seconds}s
        </span>
      </div>
      <p className="mt-2.5">
        It sees every beat, every step the agent took and every answer the world gave — the whole
        artifact, not a summary. Leave this open; closing it would not stop the call.
      </p>
    </div>
  );
}

function Landed({ report, spendUsd }: { report: EpisodeJudgeReport; spendUsd: number | null }) {
  const findings = report.findings.length + report.otherFindings.length;
  const critical = [...report.findings, ...report.otherFindings].filter(
    (f) => f.severity === "critical",
  ).length;

  return (
    <div aria-live="polite" className="rounded-sn-xl border border-sn-passed-line bg-sn-passed-soft px-4 py-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border border-sn-passed-line bg-sn-surface text-sn-passed-ink">
          <IconCheck size="xs" />
        </span>
        <span className="text-sn-base font-medium text-sn-ink">
          <span className="font-mono text-sn-sm">{report.model}</span> judged this run
        </span>
      </div>
      {/* What it cost, beside what it found: this reading was paid for on the
          owner's key, and the figure belongs where the decision to press again
          is made. It joins the run's cost breakdown too. */}
      <dl className="mt-3 grid grid-cols-4 gap-3 text-sn-sm">
        <Fact label="Judged" value={formatWhen(report.judgedAt)} />
        <Fact label="Its autonomy read" value={formatPercent(report.autonomyScore)} />
        <Fact
          label="Findings"
          value={`${findings}${critical > 0 ? ` · ${critical} critical` : ""}`}
        />
        <Fact label="This pass cost" value={formatUsd(spendUsd)} />
      </dl>
      <p className="mt-3 text-sn-sm leading-[19px] text-sn-muted">
        {report.summary?.trim()
          ? report.summary
          : "It returned no summary — the findings below are all it had to say."}
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sn-xs font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {label}
      </dt>
      <dd data-numeric className="mt-0.5 text-sn-base text-sn-ink">
        {value}
      </dd>
    </div>
  );
}
