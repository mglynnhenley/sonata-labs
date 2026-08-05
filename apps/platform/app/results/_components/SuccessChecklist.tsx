"use client";

import { useState } from "react";
import { decidedCriteria, type CriterionResult } from "@sonata/core";
import { Card, Chip, IconAlert, IconArrowRight, IconCheck, IconChevronDown, IconClose, IconMinus, cn } from "@sonata/ui";
import { formatPercent } from "../_lib/summary";

// The checklist, with its work shown. A criterion is a claim about the day, so
// clicking one opens the evidence the checker quoted and, when it knows which
// tick satisfied it, hands off to the replay. A green tick nobody can open is
// exactly the dead-end stat the spec bans.
//
// Three states, not two. A criterion nothing could decide is not a failure and
// must never be shown as one — it is the row a reader would otherwise carry out
// of here as "the agent didn't do this", from a run that gave no evidence either
// way. It is drawn apart, counted apart, and excluded from the denominator, the
// same way `checklistScore` excludes it.

export function SuccessChecklist({
  checklist,
  score,
  onJump,
}: {
  checklist: CriterionResult[];
  score: number | null;
  /** Park the replay on the tick this criterion was satisfied. */
  onJump: (target: { tick: number }) => void;
}) {
  const decided = decidedCriteria(checklist);
  const passed = decided.filter((c) => c.status === "passed").length;
  const undecided = checklist.length - decided.length;

  return (
    <Card
      padding="none"
      radius="2xl"
      title="Did it get the job done?"
      subtitle={
        checklist.length === 0
          ? "This run has no checklist yet."
          : decided.length === 0
            ? `Nothing on this checklist could be decided from what the run left behind — all ${checklist.length} criteria are unchecked, and none of them counts either way.`
            : `${passed} of ${decided.length} criteria passed — ${formatPercent(score)} by weight.` +
              (undecided > 0
                ? ` ${undecided} more could not be decided, so ${undecided === 1 ? "it is" : "they are"} not counted either way.`
                : "")
      }
      className="scroll-mt-6"
    >
      {checklist.length === 0 ? (
        <p className="px-5 pb-5 text-[13px] text-sn-muted">
          Criteria are declared on the scenario and checked in code against the world the agent
          left behind. Nothing has been checked for this run — it is either still going or it
          stopped before scoring.
        </p>
      ) : (
        <ul className="border-t border-sn-line">
          {checklist.map((criterion) => (
            <CriterionRow key={criterion.id} criterion={criterion} onJump={onJump} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function CriterionRow({
  criterion,
  onJump,
}: {
  criterion: CriterionResult;
  onJump: (target: { tick: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  // Captured, because narrowing on a property does not survive into the callback.
  const tick = criterion.tick;
  const passed = criterion.status === "passed";
  const undecided = criterion.status === "notApplicable";

  return (
    <li className="border-b border-sn-line/70 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-start gap-3 px-5 py-3 text-left",
          "transition-colors duration-150 ease-sn hover:bg-sn-surface-hover",
        )}
      >
        {/* Undecided is its own mark, deliberately not a red cross: a hollow
            dash reads as "nothing to say", which is what it means. */}
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border",
            undecided
              ? "border-dashed border-sn-line-strong bg-sn-bg-subtle text-sn-subtle"
              : passed
                ? "border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink"
                : "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
          )}
        >
          {undecided ? (
            <IconMinus size={11} />
          ) : passed ? (
            <IconCheck size={11} />
          ) : (
            <IconClose size={11} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] text-sn-ink">{criterion.description}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-sn-subtle">
            {undecided ? (
              <>
                <span className="font-medium text-sn-muted">could not be checked</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span className="font-mono">{criterion.id}</span>
            <span aria-hidden="true">·</span>
            <span>{criterion.kind}</span>
            {criterion.twin !== "any" ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{criterion.twin}</span>
              </>
            ) : null}
            {criterion.weight !== 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>weight {criterion.weight}</span>
              </>
            ) : null}
          </span>
        </span>

        {criterion.severity === "must" ? (
          // Only a DECIDED must can fail the run, so only a failed one is drawn
          // in alarm. An undecided must is not an accusation.
          <Chip
            size="sm"
            icon={false}
            className={cn(
              "mt-0.5",
              passed || undecided
                ? "border-sn-line bg-sn-bg-subtle text-sn-muted"
                : "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
            )}
            title="A failed must-criterion fails the whole run. One nothing could decide does not."
          >
            must
          </Chip>
        ) : null}

        <IconChevronDown
          size={15}
          className={cn(
            "mt-1 shrink-0 text-sn-subtle transition-transform duration-150 ease-sn",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="animate-sn-slide-in px-5 pb-4 pl-[52px]">
          {criterion.evidence?.trim() ? (
            <blockquote className="rounded-sn-lg border border-sn-line bg-sn-bg-subtle p-3 text-[13px] leading-[20px] text-sn-muted">
              {criterion.evidence}
            </blockquote>
          ) : (
            <p className="flex items-start gap-2 text-[13px] text-sn-muted">
              <IconAlert size={14} className="mt-0.5 shrink-0 text-sn-subtle" />
              {undecided
                ? "No checker could settle this from what the run left behind, so it is neither passed nor failed and takes no part in the score."
                : passed
                  ? "The checker passed this without quoting anything — it matched on state, not on a message."
                  : "Nothing in the world satisfied this criterion, so there is nothing to quote."}
            </p>
          )}

          {tick !== undefined ? (
            <button
              type="button"
              onClick={() => onJump({ tick })}
              className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-sn-primary-ink hover:underline"
            >
              Go to tick {tick} in the replay
              <IconArrowRight size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
