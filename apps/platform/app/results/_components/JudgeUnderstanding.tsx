"use client";

import { useState } from "react";
import type { EpisodeJudgeReport } from "@sonata/core";
import { Card, IconChevronDown, cn } from "@sonata/ui";
import type { ReactNode } from "react";
import type { RunBrief } from "../_lib/artifacts";
import { formatWhen } from "../_lib/summary";
import { judgeSight, sliceSentence } from "./harness";

// First on the page, before any score: the judge restates the task in its own
// words. If the restatement is not the task, the brief was ambiguous — and that
// is the finding, not the run's score. Everything below this section is only
// worth reading once this paragraph is right.
//
// "How it went" is the most quotable paragraph on the page and the one with the
// least visible provenance, so what it was written from is stamped on it. A
// summary formed on a sample of the day reads exactly like one formed on all of
// it, and that resemblance is the whole problem.

export function JudgeUnderstanding({
  judge,
  brief,
  rejudge,
}: {
  judge: EpisodeJudgeReport | null;
  brief: RunBrief;
  /** The re-judge control, so the empty state can offer the one action. */
  rejudge?: ReactNode;
}) {
  const [briefOpen, setBriefOpen] = useState(false);

  if (!judge) {
    return (
      <Card padding="lg" radius="2xl" className="scroll-mt-6">
        <h2 className="font-display text-[26px] text-sn-ink">No judge has read this run yet</h2>
        <p className="mt-2 max-w-[60ch] text-[13.5px] leading-[21px] text-sn-muted">
          The checklist is deterministic and runs in code; the judge is a separate pass over the
          same saved artifact. Run it and you get the task restated in its own words, the failure
          modes it found, and the evidence for each one.
        </p>
        {rejudge ? <div className="mt-5">{rejudge}</div> : null}
      </Card>
    );
  }

  return (
    <Card padding="lg" radius="2xl" className="scroll-mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-medium text-sn-ink">
          What the judge thinks the task was
        </h2>
        <span className="text-[11.5px] text-sn-subtle">
          <span className="font-mono">{judge.model}</span>
          {judge.judgedAt ? ` · judged ${formatWhen(judge.judgedAt)}` : ""}
        </span>
      </div>

      <blockquote className="mt-3 rounded-sn-xl border border-sn-line bg-sn-bg-subtle p-4 text-[14px] leading-[22px] whitespace-pre-wrap text-sn-ink">
        {judge.taskUnderstanding || "The judge returned no restatement."}
      </blockquote>
      <p className="mt-2 text-[12px] text-sn-subtle">
        If that isn&apos;t the task, the brief is ambiguous — and that ambiguity is itself the
        finding.
      </p>

      {brief.task ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setBriefOpen((o) => !o)}
            aria-expanded={briefOpen}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-sn-primary-ink hover:underline"
          >
            {briefOpen ? "Hide the brief the agent was given" : "Compare with the brief the agent was given"}
            <IconChevronDown
              size={13}
              className={cn("transition-transform duration-150 ease-sn", briefOpen && "rotate-180")}
            />
          </button>
          {briefOpen ? (
            <div className="animate-sn-slide-in mt-2.5 space-y-3">
              <Field label="The brief, verbatim" value={brief.task} />
              {brief.story ? <Field label="The day, as the author wrote it" value={brief.story} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {judge.summary ? (
        <div className="mt-5 border-t border-sn-line pt-4">
          <h3 className="text-[12px] font-medium tracking-[0.04em] text-sn-subtle uppercase">
            How it went
          </h3>
          <p className="mt-1.5 text-[13.5px] leading-[21px] text-sn-ink">{judge.summary}</p>
          <SightNote judge={judge} />
        </div>
      ) : null}

      {judge.answers.length > 0 ? (
        <dl className="mt-5 space-y-3 border-t border-sn-line pt-4">
          {judge.answers.map((answer, i) => (
            <div key={i}>
              <dt className="text-[12.5px] font-medium text-sn-ink">{answer.question}</dt>
              <dd className="mt-0.5 text-[13px] leading-[20px] text-sn-muted">{answer.answer}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

/** What the paragraph above was written from. Silent only when it was the whole day. */
function SightNote({ judge }: { judge: EpisodeJudgeReport }) {
  const sight = judgeSight(judge);
  if (!sight) return null;
  return (
    <p className="mt-2 text-[12px] leading-[18px] text-sn-gold-ink">
      {sight.kind === "partial"
        ? `Written from ${sight.portion} of this day — the assessor read ${sliceSentence(sight.missing[0])}, sampled evenly across it. Ours, not the agent's.`
        : "How much of this day the assessor read was not recorded, so this paragraph cannot be taken as a reading of all of it."}
    </p>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {label}
      </div>
      <p className="mt-1 rounded-sn-lg border border-sn-line bg-sn-surface-hover p-3 text-[13px] leading-[20px] whitespace-pre-wrap text-sn-muted">
        {value}
      </p>
    </div>
  );
}
