"use client";

import { useState } from "react";
import type { EpisodeJudgeReport } from "@sonata/core";
import { Card, IconCheck, IconChevronDown, IconClose, Spinner, cn } from "@sonata/ui";
import type { ReactNode } from "react";
import type { RunBrief } from "../_lib/artifacts";
import { formatWhen } from "../_lib/summary";
import { judgeSight, sliceSentence } from "./harness";
import { judgeCopy } from "./judgeCopy";
import { useJudgeState } from "./judgeState";

// First on the page, before any score: the judge restates the task in its own
// words. If the restatement is not the task, the brief was ambiguous — and that
// is the finding, not the run's score. Everything below this section is only
// worth reading once this paragraph is right.
//
// "How it went" is the most quotable paragraph on the page and the one with the
// least visible provenance, so what it was written from is stamped on it. A
// summary formed on a sample of the day reads exactly like one formed on all of
// it, and that resemblance is the whole problem.

/** A step reference the judge writes into its prose — `[47]`, `[47], [51]`. */
const SEQ_REF = /\[\d+\]/;

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
  const state = useJudgeState();
  // All four are absent on a report written before the account was broken into
  // lists. Those reports still render: the whole thing is in `summary`.
  const taskPoints = judge?.taskPoints ?? [];
  const ambiguities = judge?.taskAmbiguities ?? [];
  const did = judge?.did ?? [];
  const didNot = judge?.didNot ?? [];

  if (!judge) {
    // The state, not the silence. A run judges itself when it ends, so this card
    // is now the place a reader finds out what happened to a pass they never had
    // to ask for — and the only one of the three that carries the button, so the
    // action sits with the explanation instead of three sections offering it.
    const copy = judgeCopy(state);
    return (
      <Card padding="lg" radius="2xl" className="scroll-mt-6">
        <div className="flex items-center gap-2.5">
          {copy.tone === "waiting" ? <Spinner size="sm" label="" /> : null}
          <h2
            className={cn(
              "font-display text-sn-2xl",
              copy.tone === "failed" ? "text-sn-failed-ink" : "text-sn-ink",
            )}
          >
            {copy.headline}
          </h2>
        </div>
        <p className="mt-2 max-w-[60ch] text-sn-base text-sn-muted">
          {copy.detail}
        </p>
        <p className="mt-2 max-w-[60ch] text-sn-base text-sn-subtle">
          {copy.footnote ??
            "Two passes score a run. The checklist runs in code and is exact. The judge is a model " +
              "reading the same saved day: it restates the task, names the failure modes it found, " +
              "and quotes the evidence for each one."}
        </p>
        {/* Nothing to press while a pass is in flight: a second one would be a
            second bill for the same reading. */}
        {rejudge && copy.tone !== "waiting" ? <div className="mt-5">{rejudge}</div> : null}
      </Card>
    );
  }

  return (
    <Card padding="lg" radius="2xl" className="scroll-mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sn-md font-medium text-sn-ink">
          The task, as the judge understood it
        </h2>
        {/* Who read it, when, and whether anybody asked — the pass is automatic
            now, and a reader who did not press anything is owed that fact. */}
        <span className="text-sn-xs text-sn-subtle">
          <span className="font-mono">{judge.model}</span>
          {judge.judgedAt ? ` · judged ${formatWhen(judge.judgedAt)}` : ""}
          {state?.state === "judged"
            ? state.automatic
              ? ", when the day ended"
              : ", on request"
            : ""}
        </span>
      </div>

      {/* The instruction goes ABOVE the restatement, not below it. A reader told
          what to do with a paragraph only after they have read it has read it
          twice; scanners never reach the second line at all. */}
      <p className="mt-1 max-w-[70ch] text-sn-sm text-sn-muted">
        Read this before the score. If it isn&apos;t the job you set, the brief was ambiguous —
        and that ambiguity is the finding.
      </p>

      <div className="mt-3 rounded-sn-xl border border-sn-line bg-sn-bg-subtle p-4">
        <p className="text-sn-md whitespace-pre-wrap text-sn-ink">
          {judge.taskUnderstanding || "The judge returned no restatement."}
        </p>
        {/* The jobs, as a list, because that is what the reader is checking it
            against. Older reports have no `taskPoints` and carry the whole task
            in the sentence above, which still reads correctly on its own. */}
        {taskPoints.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {taskPoints.map((point, i) => (
              <li key={i} className="flex gap-2.5 text-sn-base text-sn-ink">
                <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-sn-line-strong" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Pulled out of the restatement and given its own box. An ambiguous brief
          is our defect, it changes how harshly everything below should be read,
          and as a trailing clause of a paragraph it was read by nobody. */}
      {ambiguities.length > 0 ? (
        <div className="mt-3 rounded-sn-xl border border-sn-gold/40 bg-sn-gold-soft/35 px-4 py-3">
          <h3 className="text-sn-sm font-medium text-sn-gold-ink">
            {ambiguities.length === 1
              ? "The brief left one thing unclear"
              : `The brief left ${ambiguities.length} things unclear`}
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {ambiguities.map((point, i) => (
              <li key={i} className="flex gap-2.5 text-sn-base text-sn-muted">
                <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-sn-gold" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sn-sm text-sn-subtle">
            Ours, not the agent&rsquo;s. Judge its choices below with that in mind.
          </p>
        </div>
      ) : null}

      {brief.task ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setBriefOpen((o) => !o)}
            aria-expanded={briefOpen}
            className="inline-flex items-center gap-1.5 text-sn-sm font-medium text-sn-primary-ink hover:underline"
          >
            {briefOpen ? "Hide the brief the agent was given" : "Compare with the brief the agent was given"}
            <IconChevronDown
              size="sm"
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

      {judge.summary || did.length > 0 || didNot.length > 0 ? (
        <div className="mt-5 border-t border-sn-line pt-4">
          <h3 className="text-sn-sm font-medium tracking-[0.04em] text-sn-subtle uppercase">
            How it went
          </h3>
          {/* The verdict, on its own line, in the size it deserves. On a report
              written before the split this is still the whole 3-5 sentence
              account, so it is styled to survive being long. */}
          {judge.summary ? (
            <p className="mt-1.5 max-w-[75ch] text-sn-md leading-[1.5] text-sn-ink">
              {judge.summary}
            </p>
          ) : null}

          {did.length > 0 || didNot.length > 0 ? (
            <div className="mt-3.5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Ledger kind="did" items={did} />
              <Ledger kind="didNot" items={didNot} />
            </div>
          ) : null}

          {/* The one piece of notation on this card, explained where it is read
              rather than in a legend nobody scrolls to. Only when it is actually
              there: a report that names no steps needs no key. */}
          {SEQ_REF.test(`${judge.summary} ${did.join(" ")} ${didNot.join(" ")}`) ? (
            <p className="mt-3 text-sn-sm text-sn-subtle">
              Numbers in brackets are steps — find them in the replay further down.
            </p>
          ) : null}
          <SightNote judge={judge} />
        </div>
      ) : null}

      {judge.answers.length > 0 ? (
        // This list arrived with no heading at all, so the questions read as
        // more of the summary above. They are a different thing: the parts of
        // the day no check can settle, put to the judge by name.
        <div className="mt-5 border-t border-sn-line pt-4">
          <h3 className="text-sn-sm font-medium tracking-[0.04em] text-sn-subtle uppercase">
            Questions this day asked
          </h3>
          <p className="mt-1 max-w-[70ch] text-sn-sm text-sn-subtle">
            Written into the scenario because no automatic check can settle them.
          </p>
          <dl className="mt-3 space-y-3">
            {judge.answers.map((answer, i) => (
              <div key={i}>
                <dt className="text-sn-sm font-medium text-sn-ink">{answer.question}</dt>
                <dd className="mt-0.5 text-sn-base text-sn-muted">{answer.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One side of the account: what got done, or what was left.
 *
 * Two columns rather than one list with mixed marks, because the question a reader
 * brings to this page is "what do I still have to do myself" and that answer should
 * be readable without filtering. An empty column still renders — "nothing was left"
 * is the best result this product can report, and it must not look like a section
 * that failed to load.
 */
function Ledger({ kind, items }: { kind: "did" | "didNot"; items: string[] }) {
  const done = kind === "did";
  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-sn-sm font-medium text-sn-ink">
        <span
          aria-hidden
          className={cn(
            "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border",
            done
              ? "border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink"
              : "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
          )}
        >
          {done ? <IconCheck size="xs" /> : <IconClose size="xs" />}
        </span>
        {done ? "What it did" : "What it left"}
      </h4>
      {items.length === 0 ? (
        <p className="mt-1.5 text-sn-base text-sn-muted">
          {done ? "Nothing. It finished none of the day." : "Nothing. It finished the day."}
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2.5 text-sn-base text-sn-muted">
              <span
                aria-hidden
                className={cn(
                  "mt-[9px] h-1 w-1 shrink-0 rounded-full",
                  done ? "bg-sn-passed-line" : "bg-sn-failed-line",
                )}
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the paragraph above was written from. Silent only when it was the whole day. */
function SightNote({ judge }: { judge: EpisodeJudgeReport }) {
  const sight = judgeSight(judge);
  if (!sight) return null;
  return (
    <p className="mt-2 text-sn-sm text-sn-gold-ink">
      {sight.kind === "partial"
        ? `Written from ${sight.portion} of this day, not all of it. The assessor read ${sliceSentence(sight.missing[0])}, sampled evenly. Our limit, not the agent's.`
        : "How much of this day the assessor read was never recorded. Do not read this paragraph as a reading of the whole day."}
    </p>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sn-xs font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {label}
      </div>
      <p className="mt-1 rounded-sn-lg border border-sn-line bg-sn-surface-hover p-3 text-sn-base whitespace-pre-wrap text-sn-muted">
        {value}
      </p>
    </div>
  );
}
