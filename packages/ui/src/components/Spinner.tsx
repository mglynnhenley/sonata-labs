import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<SpinnerSize, number> = { xs: 12, sm: 14, md: 18, lg: 26 };

export type SpinnerProps = HTMLAttributes<HTMLSpanElement> & {
  size?: SpinnerSize;
  /** Announced to screen readers; pass "" inside a control that already says it. */
  label?: string;
};

/** Inherits currentColor so it works on any button variant. */
export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = "sm", label = "Loading", className, ...rest },
  ref,
) {
  const px = SIZES[size];
  return (
    <span ref={ref} className={cn("inline-flex items-center", className)} {...rest}>
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.22" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
});
