"use client";

import { useState } from "react";
import type { CriterionResult } from "@sonata/core";
import { Card, Chip, IconAlert, IconArrowRight, IconCheck, IconChevronDown, IconClose, cn } from "@sonata/ui";
import { formatPercent } from "../_lib/summary";

// The checklist, with its work shown. A criterion is a claim about the day, so
// clicking one opens the evidence the checker quoted and, when it knows which
// tick satisfied it, hands off to the replay. A green tick nobody can open is
// exactly the dead-end stat the spec bans.

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
  const passed = checklist.filter((c) => c.passed).length;

  return (
    <Card
      padding="none"
      radius="2xl"
      title="Did it get the job done?"
      subtitle={
        checklist.length === 0
          ? "This run has no checklist yet."
          : `${passed} of ${checklist.length} criteria passed — ${formatPercent(score)} by weight.`
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
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border",
            criterion.passed
              ? "border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink"
              : "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
          )}
        >
          {criterion.passed ? <IconCheck size={11} /> : <IconClose size={11} />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] text-sn-ink">{criterion.description}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-sn-subtle">
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
          <Chip
            size="sm"
            icon={false}
            className={cn(
              "mt-0.5",
              criterion.passed
                ? "border-sn-line bg-sn-bg-subtle text-sn-muted"
                : "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
            )}
            title="A failed must-criterion fails the whole run."
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
              {criterion.passed
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
