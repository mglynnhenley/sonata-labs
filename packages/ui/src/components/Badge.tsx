import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";
import { STATUS_LABELS, type StatusId } from "../tokens";

export type BadgeStatus = StatusId;
export type BadgeSize = "sm" | "md";

const TONES: Record<BadgeStatus, string> = {
  running: "border-sn-running-line bg-sn-running-soft text-sn-running-ink",
  passed: "border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink",
  failed: "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
  pending: "border-sn-pending-line bg-sn-pending-soft text-sn-pending-ink",
  warning: "border-sn-warning-line bg-sn-warning-soft text-sn-warning-ink",
  neutral: "border-sn-neutral-line bg-sn-neutral-soft text-sn-neutral-ink",
};

const SIZES: Record<BadgeSize, string> = {
  sm: "h-5 gap-1.5 px-1.5 text-[11px]",
  md: "h-6 gap-1.5 px-2 text-[12px]",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  status?: BadgeStatus;
  size?: BadgeSize;
  /** Leading dot. On `running` it breathes, so a live run is visible at a glance. */
  dot?: boolean;
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { status = "neutral", size = "md", dot = true, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap",
        TONES[status],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-current",
            status === "running" && "animate-sn-pulse",
          )}
          aria-hidden="true"
        />
      ) : null}
      {children ?? STATUS_LABELS[status]}
    </span>
  );
});
