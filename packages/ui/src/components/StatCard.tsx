"use client";

import { forwardRef, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { cn } from "../cn";
import { IconArrowDown, IconArrowUp, IconChevronRight, IconMinus } from "./icons";

export type StatDelta = {
  value: ReactNode;
  direction?: "up" | "down" | "flat";
  /** Whether the movement is good news. Defaults to up = good. */
  tone?: "positive" | "negative" | "neutral";
  /** e.g. "vs. last run" */
  label?: ReactNode;
};

export type StatCardProps = {
  label: ReactNode;
  value: ReactNode;
  /** Small unit that trails the number: "%", "runs", "s". */
  unit?: ReactNode;
  delta?: StatDelta;
  /** Up to two lines under the number explaining what it counts. */
  hint?: ReactNode;
  icon?: ReactNode;
  /** Making it a door: pass href or onClick and the whole card becomes the target. */
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  /** Overrides the "See the evidence" affordance text for screen readers. */
  actionLabel?: string;
  loading?: boolean;
  className?: string;
};

const DELTA_TONES = {
  positive: "text-sn-success-ink",
  negative: "text-sn-danger-ink",
  neutral: "text-sn-muted",
} as const;

function deltaTone(delta: StatDelta): keyof typeof DELTA_TONES {
  if (delta.tone) return delta.tone;
  if (delta.direction === "up") return "positive";
  if (delta.direction === "down") return "negative";
  return "neutral";
}

/**
 * The spec's "every number is a door": a stat is never a dead end, so this
 * renders as a link or a button whenever a destination is given.
 */
export const StatCard = forwardRef<HTMLElement, StatCardProps>(function StatCard(
  {
    label,
    value,
    unit,
    delta,
    hint,
    icon,
    href,
    onClick,
    actionLabel = "See the evidence",
    loading = false,
    className,
  },
  ref,
) {
  const clickable = Boolean(href || onClick);
  const DeltaIcon =
    delta?.direction === "down" ? IconArrowDown : delta?.direction === "flat" ? IconMinus : IconArrowUp;

  const footnote = hint ?? delta?.label;
  // The clamp below hides the tail of a long footnote, so hand the browser the
  // whole sentence for the tooltip. Only a plain string has one to hand over.
  const footnoteTitle = typeof footnote === "string" ? footnote : undefined;

  const body = (
    <>
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sn-md bg-sn-bg-subtle text-sn-muted">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 text-[12px] font-medium tracking-[0.02em] text-sn-muted uppercase">
          {label}
        </span>
        {clickable ? (
          <IconChevronRight
            size="md"
            className="mt-0.5 shrink-0 text-sn-subtle transition-transform duration-150 ease-sn group-hover:translate-x-0.5 group-hover:text-sn-ink"
          />
        ) : null}
      </div>

      {/* The number and its footnote travel together, so the footnote can only
          grow downwards and never shove the number off the row's baseline. */}
      <div className="sn-stack-item">
        <div className="flex items-baseline gap-1.5">
          {loading ? (
            <span className="sn-skeleton mt-1 block h-8 w-24" aria-hidden="true" />
          ) : (
            <span
              data-numeric
              className="text-[34px] leading-none font-medium tracking-[-0.02em] text-sn-ink"
            >
              {value}
            </span>
          )}
          {unit && !loading ? <span className="text-[14px] text-sn-muted">{unit}</span> : null}
          {delta && !loading ? (
            <span
              className={cn(
                "ml-1 inline-flex items-center gap-0.5 text-[12px] font-medium",
                DELTA_TONES[deltaTone(delta)],
              )}
            >
              <DeltaIcon size="xs" />
              {delta.value}
            </span>
          ) : null}
        </div>

        {/* Two lines once the cards share a row — Home's Autonomy footnote ran
            to six, and the other three cards carried the void. Only from `sm`,
            because below it the grid is one column: nothing is beside the card
            to be levelled with, and a phone has no hover to recover the rest of
            the sentence with. The words are never cut, only the paint: the whole
            string stays in the DOM, because these caveats are what make the
            number above them honest. */}
        {footnote ? (
          <p title={footnoteTitle} className="text-[12px] text-sn-subtle sm:line-clamp-2">
            {footnote}
          </p>
        ) : null}
      </div>
      {clickable ? <span className="sr-only">{actionLabel}</span> : null}
    </>
  );

  const classes = cn(
    "group sn-stack-group rounded-sn-2xl border border-sn-line bg-sn-surface p-5 text-left shadow-sn-xs",
    "transition-[box-shadow,border-color,transform] duration-150 ease-sn",
    clickable && "hover:-translate-y-px hover:border-sn-line-strong hover:shadow-sn-md",
    className,
  );

  if (href) {
    return (
      <a ref={ref as Ref<HTMLAnchorElement>} href={href} onClick={onClick} className={classes}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        onClick={onClick}
        className={cn(classes, "w-full")}
      >
        {body}
      </button>
    );
  }
  return (
    <div ref={ref as Ref<HTMLDivElement>} className={classes}>
      {body}
    </div>
  );
});
