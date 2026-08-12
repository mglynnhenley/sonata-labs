import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

export type ProgressTone = "primary" | "gold" | "success" | "danger";
export type ProgressSize = "sm" | "md";

const TONES: Record<ProgressTone, string> = {
  primary: "bg-sn-primary",
  gold: "bg-sn-gold",
  success: "bg-sn-success",
  danger: "bg-sn-danger",
};

const SIZES: Record<ProgressSize, string> = { sm: "h-1", md: "h-2" };

export type ProgressBarProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  value: number;
  max?: number;
  label?: ReactNode;
  /** Prints "3 / 12" (or the percentage) beside the label. */
  showValue?: boolean;
  valueLabel?: ReactNode;
  tone?: ProgressTone;
  size?: ProgressSize;
  /** For work with no known length — the tick loop before the day is planned. */
  indeterminate?: boolean;
};

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(function ProgressBar(
  {
    value,
    max = 100,
    label,
    showValue = false,
    valueLabel,
    tone = "primary",
    size = "md",
    indeterminate = false,
    className,
    ...rest
  },
  ref,
) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const pct = (clamped / safeMax) * 100;

  return (
    <div ref={ref} className={cn("w-full", className)} {...rest}>
      {label || showValue ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12px]">
          {label ? <span className="text-sn-muted">{label}</span> : <span />}
          {showValue ? (
            <span data-numeric className="font-medium text-sn-ink">
              {valueLabel ?? `${Math.round(pct)}%`}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={indeterminate ? undefined : safeMax}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={indeterminate ? "Working…" : undefined}
        aria-label={typeof label === "string" ? label : undefined}
        className={cn("overflow-hidden rounded-full bg-sn-bg-subtle", SIZES[size])}
      >
        {/* A determinate bar is full-width and scaled down, not a width that
            animates: width is a layout property, so a run ticking every second
            re-laid out the page on every tick. scaleX is composited.
            No radius of its own — scaling would stretch it into an ellipse, and
            the track is already rounded and clipping. */}
        <div
          className={cn(
            "h-full origin-left transition-transform duration-300 ease-sn",
            TONES[tone],
            indeterminate ? "animate-sn-indeterminate w-1/3 rounded-full" : "w-full",
          )}
          style={indeterminate ? undefined : { transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  );
});
