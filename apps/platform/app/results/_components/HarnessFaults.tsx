"use client";

import { useState, type ReactNode } from "react";
import { Badge, Card, Chip, IconAlert, IconChevronDown, cn } from "@sonata/ui";
import { SEVERITY_BADGE } from "../_lib/summary";
import {
  FAULT_LABEL,
  faultPhrase,
  sentence,
  sliceSentence,
  type FaultedCriterion,
  type FaultedFinding,
  type HarnessReport,
  type JudgeSight,
  type MissedMoment,
} from "./harness";

// OUR HALF OF THE BAD NEWS, FIRST AND IN OUR OWN VOICE.
//
// This card exists because of a report a reader could not use. Eight findings on
// one run, printed identically; four were the model's, and the rest were a day we
// cut off at a third and a clone we forgot to photograph. A reader with no way to
// tell them apart concludes the model is bad, and a benchmark that lets them do
// that cannot be published.
//
// So the separation is made here, above everything, and it is made in the first
// person. Not "criteria could not be evaluated" — WE did not run the day, WE did
// not save the evidence. Everything below this card on the page is then the
// agent's record and only the agent's, which is what makes the rest of the page
// safe to read.

const WHY_UNFIRED: Record<MissedMoment["why"], string> = {
  "cut-short": "the day ended before it",
  skipped: "its tick ran and nothing fired",
  "inject-failed": "the clone refused it",
};

const TWIN_LABEL: Record<MissedMoment["twin"], string> = {
  gmail: "Email",
  slack: "Slack",
  calendar: "Calendar",
  attio: "CRM",
  "google-docs": "Docs",
  "google-ads": "Ads",
  linkedin: "LinkedIn",
};

export function HarnessFaults({ report }: { report: HarnessReport }) {
  const { day, capture, sight, criteria, findings } = report;

  return (
    <Card padding="none" radius="2xl" className="border-sn-gold/45 bg-sn-gold-soft/35">
      <div className="flex items-start gap-4 p-5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[14px] font-medium text-sn-gold-ink">
            <IconAlert size={15} />
            Ours, not the agent&rsquo;s
          </h2>
          <p className="mt-0.5 max-w-[80ch] text-[13px] leading-[20px] text-sn-muted">
            Defects in this harness, separated from the model&rsquo;s record and counted nowhere in
            it. Everything else on this page is the agent&rsquo;s.
          </p>
        </div>
        {day ? (
          <Chip size="sm" icon={false} className="border-sn-gold/50 bg-sn-surface text-sn-gold-ink">
            {day.ran} of {day.declared} ticks
          </Chip>
        ) : null}
      </div>

      <div className="divide-y divide-sn-gold/30 border-t border-sn-gold/30">
        {day ? <ShortDay day={day} /> : null}
        {capture ? <Capture summary={capture} /> : null}
        {sight?.kind === "partial" ? <PartialSight sight={sight} /> : null}
        {criteria.length > 0 ? <Criteria rows={criteria} /> : null}
        {findings.length > 0 ? <Findings rows={findings} /> : null}
      </div>
    </Card>
  );
}

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="px-5 py-4">
      <h3 className="text-[13px] font-medium text-sn-ink">{title}</h3>
      <p className="mt-1 max-w-[78ch] text-[13px] leading-[20px] text-sn-muted">{lead}</p>
      {children}
    </section>
  );
}

/**
 * The headline fact, in words rather than in ticks. A reader who takes one thing
 * from this page has to take this: the agent was given part of a day and graded
 * against all of it.
 */
function ShortDay({ day }: { day: NonNullable<HarnessReport["day"]> }) {
  const share = Math.round((day.ran / Math.max(day.declared, 1)) * 100);
  const cut = day.ran < day.declared;

  return (
    <Section
      title={cut ? "We stopped the day early" : "The day ran, but not all of it reached the agent"}
      lead={
        cut ? (
          <>
            This run played <strong className="font-medium text-sn-ink">{day.ran} of the {day.declared} ticks</strong>{" "}
            the scenario declares — {day.from} to {day.to} of a day written through to {day.endOfDay}.
            The agent worked {share}% of the day its brief and its criteria were written for, and was
            then scored against the whole of it.
          </>
        ) : (
          <>
            Every tick ran, but {day.missed.length} scripted moment
            {day.missed.length === 1 ? "" : "s"} never landed in a clone, so the agent never saw{" "}
            {day.missed.length === 1 ? "it" : "them"}.
          </>
        )
      }
    >
      {day.missed.length > 0 ? (
        <>
          <p className="mt-3 text-[12px] font-medium tracking-[0.04em] text-sn-subtle uppercase">
            What it was never shown
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {day.missed.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-x-2.5 text-[13px] leading-[20px]">
                <span data-numeric className="w-[44px] shrink-0 text-sn-subtle">
                  {m.clock}
                </span>
                <span className="w-[62px] shrink-0 text-sn-subtle">{TWIN_LABEL[m.twin]}</span>
                <span className="min-w-0 flex-1 text-sn-ink">{m.what}</span>
                <span className="text-[11.5px] text-sn-subtle">{WHY_UNFIRED[m.why]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-[78ch] text-[13px] leading-[20px] text-sn-muted">
            Nothing that depended on {day.missed.length === 1 ? "that moment" : "those moments"} is
            the agent&rsquo;s failure. It was never shown{" "}
            {day.missed.length === 1 ? "it" : "them"}.
          </p>
        </>
      ) : null}
    </Section>
  );
}

function Capture({ summary }: { summary: string }) {
  return (
    <Section
      title="We did not save enough of this run to check it"
      lead={
        <>
          {summary} A criterion is a claim about a clone&rsquo;s state before and after; with no
          picture of either there is no before and no after, and the honest answer is that we cannot
          say — not that the agent failed.
        </>
      }
    />
  );
}

/**
 * The assessor read a sample of this day and its prose does not say so.
 *
 * The same admission as a short day, one layer in: there the agent was given part
 * of a day, here the assessor was shown part of what the agent did. Both produce a
 * confident paragraph about a run neither of them saw whole, and the reader is the
 * one who pays for the difference.
 */
function PartialSight({ sight }: { sight: Extract<JudgeSight, { kind: "partial" }> }) {
  const worst = sight.missing[0];
  const rest = sight.missing.slice(1);

  return (
    <Section
      title={`The assessor read ${sight.portion} of this day`}
      lead={
        <>
          Its findings, its summary and its answers below were written from{" "}
          <strong className="font-medium text-sn-ink">{sliceSentence(worst)}</strong>
          {rest.length > 0 ? <> — and {rest.map(sliceSentence).join(", and ")}</> : null}. The day
          was too large to put in front of it whole, so we sampled it: evenly across the day, each
          gap marked, never cut off at lunchtime. Read what it wrote as {sight.portion} of the
          story, not as the story.
        </>
      }
    >
      <ul className="mt-2.5 space-y-1">
        {sight.missing.map((slice) => (
          <li
            key={slice.what}
            className="flex flex-wrap items-baseline gap-x-2.5 rounded-sn-lg border border-sn-gold/30 bg-sn-surface/70 px-3 py-2 text-[13px] leading-[19px]"
          >
            <span className="min-w-0 flex-1 text-sn-ink">{slice.what}</span>
            <span data-numeric className="text-sn-muted">
              {slice.shown} of {slice.total}
            </span>
            <span className="w-[76px] shrink-0 text-right text-[11.5px] text-sn-gold-ink">
              {slice.total - slice.shown} unread
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Criteria({ rows }: { rows: FaultedCriterion[] }) {
  const musts = rows.filter((r) => r.criterion.severity === "must").length;
  return (
    <Section
      title={`${rows.length} ${rows.length === 1 ? "criterion" : "criteria"} ${faultPhrase(rows)}`}
      lead={
        <>
          {musts > 0 ? `${musts} of them ${musts === 1 ? "a must-do" : "must-dos"}. ` : ""}
          These are out of the score entirely — not zero, absent — and they are not in the checklist
          below.
        </>
      }
    >
      <ul className="mt-2.5 space-y-1">
        {rows.map((row) => (
          <Row
            key={row.criterion.id}
            title={row.criterion.description}
            tag={FAULT_LABEL[row.fault.kind]}
            why={row.fault.why}
          />
        ))}
      </ul>
    </Section>
  );
}

function Findings({ rows }: { rows: FaultedFinding[] }) {
  return (
    <Section
      title={`${rows.length} finding${rows.length === 1 ? "" : "s"} this run cannot hold it to`}
      lead={
        <>
          The assessor read this day as though it were whole. {rows.length === 1 ? "This is" : "These are"}{" "}
          what it said about the part that never played — moved out of &ldquo;How it failed&rdquo;
          below, kept here in full. Its written summary below still counts{" "}
          {rows.length === 1 ? "this" : "these"} against the agent: nobody told it the day was cut.
        </>
      }
    >
      <ul className="mt-2.5 space-y-1">
        {rows.map((row) => (
          <Row
            key={row.key}
            badge={row.severity}
            title={row.label}
            tag={FAULT_LABEL[row.fault.kind]}
            why={row.fault.why}
            evidence={row.evidence}
          />
        ))}
      </ul>
    </Section>
  );
}

/** One openable row. Closed it is a sentence; open it is our full reasoning. */
function Row({
  badge,
  title,
  tag,
  why,
  evidence,
}: {
  badge?: FaultedFinding["severity"];
  title: string;
  tag: string;
  why: string;
  evidence?: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-sn-lg border border-sn-gold/30 bg-sn-surface/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 ease-sn hover:bg-sn-surface"
      >
        {badge ? (
          <Badge status={SEVERITY_BADGE[badge]} size="sm">
            {badge}
          </Badge>
        ) : null}
        <span className="min-w-0 flex-1 text-[13px] leading-[19px] text-sn-ink">{title}</span>
        <span className="shrink-0 text-[11.5px] text-sn-gold-ink">{tag}</span>
        <IconChevronDown
          size={14}
          className={cn(
            "mt-0.5 shrink-0 text-sn-subtle transition-transform duration-150 ease-sn",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="animate-sn-slide-in border-t border-sn-gold/25 px-3 py-2.5">
          <p className="text-[12.5px] leading-[19px] text-sn-muted">{sentence(why)}</p>
          {evidence && evidence.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {evidence.map((quote, i) => (
                <li
                  key={i}
                  className="border-l-2 border-sn-line-strong pl-2.5 text-[12.5px] leading-[19px] text-sn-subtle"
                >
                  {quote}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
